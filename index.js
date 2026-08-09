import { extension_prompt_roles, extension_prompt_types, getMaxPromptTokens, setExtensionPrompt } from '../../../../script.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { removeReasoningFromString } from '../../../reasoning.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';

const MODULE_KEY = 'compact';
const CHAT_KEY = 'compact_v1';
const PROMPT_ID = 'compact_context';
const TEMPLATE_PATH = 'third-party/Compact';
const LOG_PREFIX = '[Compact]';

const DEFAULT_PROMPT = `You are compacting a long SillyTavern conversation into a dense continuation state.

Create a self-contained memory that lets the next model continue as if it had read the omitted conversation. Preserve information that can affect future replies, especially:
- explicit user instructions, preferences, constraints, style/roleplay rules, and standing requests;
- identities, relationships, character/world state, locations, inventory, timelines, and other continuity facts;
- goals, decisions, plans, promises, rationale, progress, completed work, current work, and remaining work;
- exact names, numbers, dates, paths, URLs, commands, code/API contracts, configuration values, and other details where precision matters;
- important discoveries, corrections, errors, failed attempts, blockers, warnings, and unresolved questions;
- the latest state of any artifact, project, story, analysis, or task.

Treat PREVIOUS COMPACTED CONTEXT as older memory and NEW TRANSCRIPT as newer evidence. When they conflict, prefer the newer transcript. Remove repetition and transient chatter, but do not discard details that may matter later. Do not invent facts. Do not answer the conversation and do not comment on the act of summarizing.

Output only the compacted continuation context, with useful headings/bullets when they improve density. Keep it within approximately {{target_tokens}} tokens.`;

const DEFAULT_INJECTION_TEMPLATE = `[Compacted conversation context — authoritative memory of earlier messages]\n{{summary}}\n[End compacted conversation context]`;

const DEFAULT_SETTINGS = Object.freeze({
    autoEnabled: true,
    showMarker: true,
    thresholdTokens: 250000,
    keepRecentTokens: 24000,
    summaryTargetTokens: 8192,
    maxInputTokens: 160000,
    minNewMessagesBetweenAutoCompacts: 3,
    prompt: DEFAULT_PROMPT,
    injectionTemplate: DEFAULT_INJECTION_TEMPLATE,
});

let initialized = false;
let inCompaction = false;

function clone(value) {
    return structuredClone(value);
}

function clampNumber(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
}

function debounce(fn, delay = 350) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

function getSettings() {
    const context = SillyTavern.getContext();
    const root = context.extensionSettings;
    if (!root[MODULE_KEY] || typeof root[MODULE_KEY] !== 'object') {
        root[MODULE_KEY] = clone(DEFAULT_SETTINGS);
    }

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (root[MODULE_KEY][key] === undefined) {
            root[MODULE_KEY][key] = clone(value);
        }
    }

    return root[MODULE_KEY];
}

function defaultChatState() {
    const settings = getSettings();
    return {
        version: 1,
        summary: '',
        compactionCount: 0,
        lastCompactedAt: null,
        lastTrigger: null,
        lastTokensBefore: null,
        lastAutoVisibleCount: 0,
        autoSnoozeUntilVisibleCount: 0,
        overridesEnabled: false,
        overrides: {
            thresholdTokens: settings.thresholdTokens,
            keepRecentTokens: settings.keepRecentTokens,
            summaryTargetTokens: settings.summaryTargetTokens,
            maxInputTokens: settings.maxInputTokens,
            prompt: settings.prompt,
        },
    };
}

function getChatState(create = true) {
    const context = SillyTavern.getContext();
    if (!context.chatMetadata) return null;

    if (!context.chatMetadata[CHAT_KEY] && create) {
        context.chatMetadata[CHAT_KEY] = defaultChatState();
    }

    const state = context.chatMetadata[CHAT_KEY];
    if (!state) return null;

    const defaults = defaultChatState();
    for (const [key, value] of Object.entries(defaults)) {
        if (state[key] === undefined) state[key] = clone(value);
    }
    if (!state.overrides || typeof state.overrides !== 'object') {
        state.overrides = clone(defaults.overrides);
    }
    for (const [key, value] of Object.entries(defaults.overrides)) {
        if (state.overrides[key] === undefined) state.overrides[key] = clone(value);
    }
    return state;
}

function getEffectiveSettings() {
    const global = getSettings();
    const state = getChatState(false);
    const source = state?.overridesEnabled ? { ...global, ...state.overrides } : global;

    return {
        autoEnabled: Boolean(global.autoEnabled),
        showMarker: Boolean(global.showMarker),
        thresholdTokens: clampNumber(source.thresholdTokens, 1000, 10000000, DEFAULT_SETTINGS.thresholdTokens),
        keepRecentTokens: clampNumber(source.keepRecentTokens, 0, 2000000, DEFAULT_SETTINGS.keepRecentTokens),
        summaryTargetTokens: clampNumber(source.summaryTargetTokens, 256, 131072, DEFAULT_SETTINGS.summaryTargetTokens),
        maxInputTokens: clampNumber(source.maxInputTokens, 4096, 4000000, DEFAULT_SETTINGS.maxInputTokens),
        minNewMessagesBetweenAutoCompacts: clampNumber(global.minNewMessagesBetweenAutoCompacts, 1, 100, DEFAULT_SETTINGS.minNewMessagesBetweenAutoCompacts),
        prompt: String(source.prompt || DEFAULT_PROMPT),
        injectionTemplate: String(global.injectionTemplate || DEFAULT_INJECTION_TEMPLATE),
    };
}

function getChatIdentity(context = SillyTavern.getContext()) {
    const owner = context.groupId ? `group:${context.groupId}` : `char:${context.characterId ?? 'none'}`;
    return `${owner}::${context.chatId ?? 'none'}`;
}

async function countTokens(text) {
    const value = String(text ?? '');
    if (!value) return 0;
    try {
        return await getTokenCountAsync(value, 0);
    } catch (error) {
        console.warn(`${LOG_PREFIX} Tokenizer failed; using conservative character estimate.`, error);
        return Math.ceil(value.length / 3.5);
    }
}

function roleLabel(message) {
    if (message?.is_user) return 'USER';
    if (message?.is_system) return 'SYSTEM';
    return 'ASSISTANT';
}

function transcriptEntry(message, index) {
    const name = String(message?.name || roleLabel(message));
    const body = String(message?.mes || '').trim();
    return `[#${index} ${roleLabel(message)} ${name}]\n${body}`;
}

function visibleEntries(chat = SillyTavern.getContext().chat) {
    if (!Array.isArray(chat)) return [];
    return chat
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message && !message.is_system && !message.extra?.compact_marker && String(message.mes || '').trim());
}

function hiddenByCompactCount(chat = SillyTavern.getContext().chat) {
    return Array.isArray(chat) ? chat.filter(message => message?.extra?.compact_hidden).length : 0;
}

function interpolatePrompt(prompt, targetTokens) {
    return String(prompt || DEFAULT_PROMPT)
        .replaceAll('{{target_tokens}}', String(targetTokens))
        .replaceAll('{{target_words}}', String(Math.max(1, Math.round(targetTokens * 0.72))));
}

function syncSummaryInjection() {
    const state = getChatState(false);
    const settings = getEffectiveSettings();
    const summary = String(state?.summary || '').trim();
    const value = summary
        ? settings.injectionTemplate.replaceAll('{{summary}}', summary)
        : '';

    // IN_PROMPT + SYSTEM mirrors SillyTavern's built-in Summary extension behavior,
    // while the actual folded source messages remain in the chat file with is_system=true.
    setExtensionPrompt(PROMPT_ID, value, extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
}

function decorateMessages() {
    const chat = SillyTavern.getContext().chat || [];
    $('#chat .mes').removeClass('compact-marker compact-hidden-history');
    chat.forEach((message, index) => {
        const node = $(`#chat .mes[mesid="${index}"]`);
        if (!node.length) return;
        if (message?.extra?.compact_marker) node.addClass('compact-marker');
        if (message?.extra?.compact_hidden) node.addClass('compact-hidden-history');
    });
}

async function persistStateAndChat({ metadata = true, chat = true } = {}) {
    const context = SillyTavern.getContext();
    if (metadata && typeof context.saveMetadata === 'function') {
        await context.saveMetadata();
    }
    if (chat && typeof context.saveChat === 'function') {
        await context.saveChat();
    }
}

async function chooseFoldAndTail(entries, keepRecentTokens, manual) {
    if (entries.length <= 2) return { fold: [], tail: entries };

    let keptTokens = 0;
    let splitAt = entries.length;
    let keptMessages = 0;

    for (let i = entries.length - 1; i >= 0; i--) {
        const item = entries[i];
        const tokens = await countTokens(transcriptEntry(item.message, item.index));
        keptTokens += tokens;
        keptMessages++;
        splitAt = i;
        if (keptMessages >= 2 && keptTokens >= keepRecentTokens) break;
    }

    let fold = entries.slice(0, splitAt);
    let tail = entries.slice(splitAt);

    // Manual /compact should still do something on a short chat: preserve the newest
    // two visible messages and fold everything older, regardless of the configured tail.
    if (manual && fold.length === 0 && entries.length > 2) {
        fold = entries.slice(0, -2);
        tail = entries.slice(-2);
    }

    return { fold, tail };
}

async function splitOversizedText(text, tokenBudget) {
    const source = String(text || '');
    if ((await countTokens(source)) <= tokenBudget) return [source];

    const parts = [];
    let start = 0;
    while (start < source.length) {
        let low = start + 1;
        let high = source.length;
        let best = low;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const sample = source.slice(start, mid);
            const tokens = await countTokens(sample);
            if (tokens <= tokenBudget) {
                best = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        // Prefer a natural newline boundary without risking a zero-length loop.
        let end = best;
        const newline = source.lastIndexOf('\n', best);
        if (newline > start + Math.floor((best - start) * 0.65)) end = newline + 1;
        if (end <= start) end = Math.min(source.length, start + 1);
        parts.push(source.slice(start, end));
        start = end;
    }
    return parts;
}

async function buildTranscriptChunks(foldEntries, maxInputTokens) {
    const unitBudget = Math.max(2048, Math.floor(maxInputTokens * 0.9));
    const units = [];

    for (const item of foldEntries) {
        const entry = transcriptEntry(item.message, item.index);
        const parts = await splitOversizedText(entry, unitBudget);
        for (let i = 0; i < parts.length; i++) {
            units.push(parts.length === 1 ? parts[i] : `${parts[i]}\n[continued ${i + 1}/${parts.length}]`);
        }
    }

    const chunks = [];
    let current = [];
    let currentTokens = 0;

    for (const unit of units) {
        const tokens = await countTokens(unit);
        if (current.length && currentTokens + tokens > maxInputTokens) {
            chunks.push(current.join('\n\n'));
            current = [];
            currentTokens = 0;
        }
        current.push(unit);
        currentTokens += tokens;
    }
    if (current.length) chunks.push(current.join('\n\n'));
    return chunks;
}

async function resolveSafeInputBudget(settings) {
    let maxPrompt = settings.maxInputTokens + settings.summaryTargetTokens + 4096;
    try {
        maxPrompt = getMaxPromptTokens(settings.summaryTargetTokens);
    } catch (error) {
        console.debug(`${LOG_PREFIX} Could not read current model prompt budget; using configured max input.`, error);
    }

    if (!Number.isFinite(maxPrompt) || maxPrompt <= 0) {
        return settings.maxInputTokens;
    }

    // Reserve space for the compaction system prompt, prior compacted context,
    // formatting overhead, and backend-specific token accounting.
    const reserve = settings.summaryTargetTokens + Math.max(2048, Math.round(maxPrompt * 0.08));
    return Math.max(4096, Math.min(settings.maxInputTokens, maxPrompt - reserve));
}

async function generateCompactedSummary(previousSummary, foldEntries, settings) {
    const context = SillyTavern.getContext();
    if (typeof context.generateRaw !== 'function') {
        throw new Error('SillyTavern generateRaw() is unavailable. Update SillyTavern to a current release.');
    }

    const inputBudget = await resolveSafeInputBudget(settings);
    const chunks = await buildTranscriptChunks(foldEntries, inputBudget);
    if (!chunks.length) throw new Error('There is no transcript content to compact.');

    const systemPrompt = interpolatePrompt(settings.prompt, settings.summaryTargetTokens);
    let running = String(previousSummary || '').trim();

    for (let i = 0; i < chunks.length; i++) {
        const previous = running ? `PREVIOUS COMPACTED CONTEXT:\n${running}` : 'PREVIOUS COMPACTED CONTEXT:\n(none)';
        const prompt = `${previous}\n\nNEW TRANSCRIPT TO FOLD IN (chunk ${i + 1}/${chunks.length}):\n${chunks[i]}`;
        const raw = await context.generateRaw({
            prompt,
            systemPrompt,
            responseLength: settings.summaryTargetTokens,
        });
        running = removeReasoningFromString(String(raw || '')).trim();
        if (!running) throw new Error(`The model returned an empty compacted context at chunk ${i + 1}/${chunks.length}.`);
    }

    // If the backend ignored the requested response length, perform one bounded
    // consolidation pass so automatic compaction does not immediately re-trigger.
    const finalTokens = await countTokens(running);
    if (finalTokens > Math.round(settings.summaryTargetTokens * 1.35)) {
        const raw = await context.generateRaw({
            prompt: `CONTEXT TO CONSOLIDATE:\n${running}`,
            systemPrompt: `${systemPrompt}\n\nThis is a final consolidation pass. Preserve all material facts while aggressively removing duplication.`,
            responseLength: settings.summaryTargetTokens,
        });
        const consolidated = removeReasoningFromString(String(raw || '')).trim();
        if (consolidated) running = consolidated;
    }

    return running;
}

function markFoldedMessages(foldEntries, generation) {
    for (const { message, index } of foldEntries) {
        if (!message.extra) message.extra = {};
        message.extra.compact_hidden = true;
        message.extra.compact_generation = generation;
        message.is_system = true;
        $(`#chat .mes[mesid="${index}"]`).attr('is_system', 'true').addClass('compact-hidden-history');
    }
}

async function addCompactionMarker(trigger) {
    const settings = getSettings();
    if (!settings.showMarker) return;

    const context = SillyTavern.getContext();
    const text = trigger === 'automatic' ? 'Context automatically compacted' : 'Context manually compacted';
    context.sendSystemMessage('generic', text, {
        compact_marker: true,
        compact_trigger: trigger,
        isSmallSys: true,
        uses_system_ui: true,
    });
    await persistStateAndChat({ metadata: false, chat: true });
    decorateMessages();
}

async function compactContext(trigger = 'manual', options = {}) {
    if (inCompaction) {
        return { success: false, reason: 'busy', message: 'Compaction is already running.' };
    }

    const context = SillyTavern.getContext();
    if (!context.chatId && !context.groupId && context.characterId == null) {
        return { success: false, reason: 'no-chat', message: 'Open a chat before using /compact.' };
    }

    const identity = getChatIdentity(context);
    const settings = getEffectiveSettings();
    const state = getChatState(true);
    const entries = visibleEntries(context.chat);
    const manual = trigger === 'manual';
    const { fold } = await chooseFoldAndTail(entries, settings.keepRecentTokens, manual);

    if (!fold.length) {
        const message = entries.length <= 2
            ? 'Nothing to compact yet. At least three visible messages are required.'
            : 'Nothing is old enough to compact with the current “Keep recent” setting.';
        if (manual) toastr.info(message, 'Compact');
        return { success: false, reason: 'nothing-to-fold', message };
    }

    let loaderHandle = null;
    try {
        inCompaction = true;
        if (context.loader?.show) {
            loaderHandle = context.loader.show({
                message: trigger === 'automatic' ? 'Automatically compacting context…' : 'Compacting context…',
                title: 'Compact',
                toastMode: 'static',
            });
        } else if (manual) {
            toastr.info('Compacting context…', 'Compact');
        }

        const summary = await generateCompactedSummary(state.summary, fold, settings);

        // A long API call must never write its result into a chat the user switched away from.
        if (getChatIdentity(SillyTavern.getContext()) !== identity) {
            console.warn(`${LOG_PREFIX} Chat changed during compaction; result discarded.`);
            return { success: false, reason: 'chat-changed', message: 'Chat changed during compaction; result discarded.' };
        }

        const current = SillyTavern.getContext();
        const currentState = getChatState(true);
        const generation = Number(currentState.compactionCount || 0) + 1;
        markFoldedMessages(fold, generation);

        currentState.summary = summary;
        currentState.compactionCount = generation;
        currentState.lastCompactedAt = new Date().toISOString();
        currentState.lastTrigger = trigger;
        currentState.lastTokensBefore = Number.isFinite(options.tokensBefore) ? Math.round(options.tokensBefore) : null;
        currentState.autoSnoozeUntilVisibleCount = 0;
        if (trigger === 'automatic') {
            currentState.lastAutoVisibleCount = visibleEntries(current.chat).length;
        }

        syncSummaryInjection();
        await persistStateAndChat({ metadata: true, chat: true });
        await addCompactionMarker(trigger);
        updateChatUi();

        const summaryTokens = await countTokens(summary);
        const result = {
            success: true,
            foldedMessages: fold.length,
            summaryTokens,
            generation,
        };
        console.info(`${LOG_PREFIX} ${trigger} compaction complete`, result);
        if (manual) toastr.success(`Folded ${fold.length} messages into ~${summaryTokens.toLocaleString()} tokens.`, 'Compact');
        return result;
    } catch (error) {
        console.error(`${LOG_PREFIX} Compaction failed`, error);
        toastr.error(String(error?.message || error), 'Compact failed');
        return { success: false, reason: 'error', message: String(error?.message || error) };
    } finally {
        inCompaction = false;
        if (loaderHandle?.hide) await loaderHandle.hide();
    }
}

async function resetCurrentChat() {
    const context = SillyTavern.getContext();
    const state = getChatState(false);
    let restored = 0;

    for (let index = 0; index < (context.chat || []).length; index++) {
        const message = context.chat[index];
        if (!message?.extra?.compact_hidden) continue;
        message.is_system = false;
        delete message.extra.compact_hidden;
        delete message.extra.compact_generation;
        restored++;
        $(`#chat .mes[mesid="${index}"]`).attr('is_system', 'false').removeClass('compact-hidden-history');
    }

    if (state) {
        const overridesEnabled = Boolean(state.overridesEnabled);
        const overrides = clone(state.overrides || defaultChatState().overrides);
        context.chatMetadata[CHAT_KEY] = defaultChatState();
        context.chatMetadata[CHAT_KEY].overridesEnabled = overridesEnabled;
        context.chatMetadata[CHAT_KEY].overrides = overrides;
    }

    syncSummaryInjection();
    await persistStateAndChat({ metadata: true, chat: true });
    decorateMessages();
    updateChatUi();
    toastr.success(`Restored ${restored} message${restored === 1 ? '' : 's'} to model context.`, 'Compact reset');
    return restored;
}

async function statusText() {
    const settings = getEffectiveSettings();
    const state = getChatState(false);
    const summaryTokens = state?.summary ? await countTokens(state.summary) : 0;
    const hidden = hiddenByCompactCount();
    return `Compact: auto=${settings.autoEnabled ? 'on' : 'off'}, threshold=${settings.thresholdTokens}, hidden=${hidden}, summary≈${summaryTokens} tokens, compactions=${state?.compactionCount || 0}, last=${state?.lastTrigger || 'never'}.`;
}

// SillyTavern calls this global function before non-dry-run prompt construction.
// contextSize is the token count for the upcoming generation.
globalThis.CompactGenerationInterceptor = async function CompactGenerationInterceptor(chat, contextSize, _abort, type) {
    if (inCompaction || type === 'quiet') return;

    const settings = getEffectiveSettings();
    if (!settings.autoEnabled || !Number.isFinite(contextSize) || contextSize < settings.thresholdTokens) return;

    const state = getChatState(true);
    const visibleCount = visibleEntries(chat).length;
    const minimumGrowth = settings.minNewMessagesBetweenAutoCompacts;

    // These guards are deliberately conservative. They prevent a bad/verbose summary
    // from causing the same generation to fall into a Codex-like repeated compact loop.
    if (state.autoSnoozeUntilVisibleCount && visibleCount < state.autoSnoozeUntilVisibleCount) return;
    if (state.lastAutoVisibleCount && visibleCount < state.lastAutoVisibleCount + minimumGrowth) return;

    const result = await compactContext('automatic', { tokensBefore: contextSize });
    if (!result.success) {
        state.autoSnoozeUntilVisibleCount = visibleCount + minimumGrowth;
        if (SillyTavern.getContext().saveMetadata) await SillyTavern.getContext().saveMetadata();
    }
};

function setDisabledState() {
    const enabled = $('#compact-chat-override-enabled').prop('checked');
    $('#compact-chat-overrides, #compact-chat-prompt').toggleClass('compact-disabled', !enabled);
    $('#compact-chat-overrides input, #compact-chat-prompt').prop('disabled', !enabled);
}

function loadGlobalUi() {
    const settings = getSettings();
    $('#compact-auto-enabled').prop('checked', Boolean(settings.autoEnabled));
    $('#compact-show-marker').prop('checked', Boolean(settings.showMarker));
    $('#compact-threshold').val(settings.thresholdTokens);
    $('#compact-keep-recent').val(settings.keepRecentTokens);
    $('#compact-summary-target').val(settings.summaryTargetTokens);
    $('#compact-max-input').val(settings.maxInputTokens);
    $('#compact-prompt').val(settings.prompt);
}

async function updateChatUi() {
    const state = getChatState(false);
    const settings = getSettings();
    const overrides = state?.overrides || {
        thresholdTokens: settings.thresholdTokens,
        keepRecentTokens: settings.keepRecentTokens,
        summaryTargetTokens: settings.summaryTargetTokens,
        maxInputTokens: settings.maxInputTokens,
        prompt: settings.prompt,
    };

    $('#compact-chat-override-enabled').prop('checked', Boolean(state?.overridesEnabled));
    $('#compact-chat-threshold').val(overrides.thresholdTokens);
    $('#compact-chat-keep-recent').val(overrides.keepRecentTokens);
    $('#compact-chat-summary-target').val(overrides.summaryTargetTokens);
    $('#compact-chat-max-input').val(overrides.maxInputTokens);
    $('#compact-chat-prompt').val(overrides.prompt);
    $('#compact-current-summary').val(state?.summary || '');
    setDisabledState();

    if (!state?.summary) {
        $('#compact-chat-status').text('No compacted context');
        return;
    }

    const hidden = hiddenByCompactCount();
    const tokens = await countTokens(state.summary);
    const when = state.lastCompactedAt ? new Date(state.lastCompactedAt).toLocaleString() : 'unknown time';
    $('#compact-chat-status').text(`${hidden} hidden · ~${tokens.toLocaleString()} summary tokens · ${state.lastTrigger || 'manual'} · ${when}`);
}

function bindSettingsUi() {
    const saveGlobal = () => SillyTavern.getContext().saveSettingsDebounced();
    const saveChatDebounced = debounce(async () => {
        const context = SillyTavern.getContext();
        if (context.saveMetadata) await context.saveMetadata();
    }, 450);

    $('#compact-auto-enabled').off('.compact').on('change.compact', function () {
        getSettings().autoEnabled = Boolean($(this).prop('checked'));
        saveGlobal();
    });
    $('#compact-show-marker').off('.compact').on('change.compact', function () {
        getSettings().showMarker = Boolean($(this).prop('checked'));
        saveGlobal();
    });

    const globalNumberBindings = [
        ['#compact-threshold', 'thresholdTokens'],
        ['#compact-keep-recent', 'keepRecentTokens'],
        ['#compact-summary-target', 'summaryTargetTokens'],
        ['#compact-max-input', 'maxInputTokens'],
    ];
    for (const [selector, key] of globalNumberBindings) {
        $(selector).off('.compact').on('change.compact', function () {
            getSettings()[key] = Number($(this).val());
            saveGlobal();
        });
    }

    $('#compact-prompt').off('.compact').on('input.compact', debounce(function () {
        getSettings().prompt = String($(this).val());
        saveGlobal();
    }));
    $('#compact-restore-prompt').off('.compact').on('click.compact', () => {
        getSettings().prompt = DEFAULT_PROMPT;
        $('#compact-prompt').val(DEFAULT_PROMPT);
        saveGlobal();
    });

    $('#compact-chat-override-enabled').off('.compact').on('change.compact', async function () {
        const state = getChatState(true);
        state.overridesEnabled = Boolean($(this).prop('checked'));
        if (state.overridesEnabled && !state.overrides) state.overrides = clone(defaultChatState().overrides);
        setDisabledState();
        if (SillyTavern.getContext().saveMetadata) await SillyTavern.getContext().saveMetadata();
    });

    const chatNumberBindings = [
        ['#compact-chat-threshold', 'thresholdTokens'],
        ['#compact-chat-keep-recent', 'keepRecentTokens'],
        ['#compact-chat-summary-target', 'summaryTargetTokens'],
        ['#compact-chat-max-input', 'maxInputTokens'],
    ];
    for (const [selector, key] of chatNumberBindings) {
        $(selector).off('.compact').on('change.compact', function () {
            const state = getChatState(true);
            state.overrides[key] = Number($(this).val());
            saveChatDebounced();
        });
    }

    $('#compact-chat-prompt').off('.compact').on('input.compact', debounce(function () {
        const state = getChatState(true);
        state.overrides.prompt = String($(this).val());
        saveChatDebounced();
    }));

    $('#compact-current-summary').off('.compact').on('input.compact', debounce(async function () {
        const state = getChatState(true);
        state.summary = String($(this).val()).trim();
        syncSummaryInjection();
        if (SillyTavern.getContext().saveMetadata) await SillyTavern.getContext().saveMetadata();
        updateChatUi();
    }, 500));

    $('#compact-run').off('.compact').on('click.compact', () => compactContext('manual'));
    $('#compact-reset').off('.compact').on('click.compact', async () => {
        if (!confirm('Reset Compact for this chat? This restores messages hidden by Compact to the model context and clears the compacted summary.')) return;
        await resetCurrentChat();
    });
}

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'compact',
        callback: async (_args, value) => {
            const action = String(value || '').trim().toLowerCase();
            if (action === 'status') {
                const text = await statusText();
                toastr.info(text, 'Compact');
                return text;
            }
            if (action === 'reset') {
                await resetCurrentChat();
                return 'Compact state reset for this chat.';
            }
            if (action && action !== 'now') {
                const text = 'Usage: /compact, /compact status, or /compact reset';
                toastr.warning(text, 'Compact');
                return text;
            }

            const result = await compactContext('manual');
            return result.success
                ? `Context manually compacted (${result.foldedMessages} messages → ~${result.summaryTokens} summary tokens).`
                : result.message || 'Context was not compacted.';
        },
        unnamedArgumentList: [
            new SlashCommandArgument('optional action: now, status, or reset', [ARGUMENT_TYPE.STRING], false, false, ''),
        ],
        helpString: 'Compacts old messages into persistent per-chat context. Use <code>/compact status</code> to inspect state or <code>/compact reset</code> to restore source messages.',
        returns: ARGUMENT_TYPE.STRING,
    }));
}

async function initialize() {
    if (initialized) return;
    initialized = true;

    getSettings();
    const html = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');
    const container = $('#extensions_settings2');
    if (!$('#compact-settings').length) container.append(html);

    loadGlobalUi();
    bindSettingsUi();
    registerSlashCommands();
    syncSummaryInjection();
    await updateChatUi();
    decorateMessages();

    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        syncSummaryInjection();
        await updateChatUi();
        setTimeout(decorateMessages, 0);
    });

    // Re-apply marker/history classes as messages are rendered or chat DOM changes.
    for (const eventName of ['CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED']) {
        const event = event_types[eventName];
        if (event) eventSource.on(event, () => setTimeout(decorateMessages, 0));
    }

    console.info(`${LOG_PREFIX} Ready. Auto threshold: ${getSettings().thresholdTokens.toLocaleString()} tokens.`);
}

jQuery(async () => {
    try {
        await initialize();
    } catch (error) {
        console.error(`${LOG_PREFIX} Initialization failed`, error);
        toastr.error(String(error?.message || error), 'Compact extension failed to load');
    }
});

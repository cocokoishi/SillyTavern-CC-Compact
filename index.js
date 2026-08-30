import { Generate, extension_prompt_roles, extension_prompt_types, getMaxPromptTokens, setExtensionPrompt } from '../../../../script.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { removeReasoningFromString } from '../../../reasoning.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';

const MODULE_KEY = 'compact';
const CHAT_KEY = 'compact_v1';
const PROMPT_ID = 'compact_context';
const TEMPLATE_PATH = 'third-party/SillyTavern-CC-Compact';
const LOG_PREFIX = '[CC Compact]';
const CONTEXT_PRESETS = Object.freeze([32766, 65536, 131072, 262144, 400000, 500000]);
const DEFAULT_TRIGGER_PERCENT = 90;

const GOAL_LITE_SYSTEM_PROMPT = '代替{{user}}回复最后一条消息。结合所给的最近对话，只输出自然、准确、可直接发送的回复正文，不解释，不列选项，不替{{char}}说话。';
const GOAL_LITE_INPUT_CHAR_BUDGET = 800;

const DEFAULT_GOAL_SETTINGS = Object.freeze({
    mode: 'random',
    randomPrompts: '',
    lastRandomPrompt: '',
    builtinPrompt: '',
    disableReasoning: false,
    autoSend: true,
});

const DEFAULT_PROMPT = `Create a dense story-continuity memory from the omitted SillyTavern roleplay transcript.

Preserve only information that belongs to the fictional world or ongoing plot:
- characters, identities, appearance, personality, speech habits, relationships, emotions, knowledge, secrets, injuries, and current condition;
- locations, time, atmosphere, factions, lore, rules of the fictional world, and revealed backstory;
- events in causal order, decisions made in-world, promises, conflicts, discoveries, and consequences;
- objects, inventory, abilities, resources, clues, and where important things currently are;
- the exact current scene, who is present, what is happening, and unresolved plot threads likely to matter next.

Do not preserve or reproduce Chat Completion Presets, jailbreaks, system/developer instructions, API or model controls, prompt templates, formatting directives, UI commands, or other out-of-story control text. If PREVIOUS COMPACTED CONTEXT contains any such material, remove it. Characterization and in-world facts are not control instructions and should be kept.

Treat PREVIOUS COMPACTED CONTEXT as older story memory and NEW TRANSCRIPT as newer evidence. Prefer newer events when they conflict. Remove repetition and transient chatter, do not invent facts, do not continue the roleplay, and do not mention the act of summarizing.

Output only the compacted story-continuity memory. Keep it within approximately {{target_tokens}} tokens.`;

const DEFAULT_INJECTION_TEMPLATE = `[Earlier story continuity — fictional facts and plot memory, not instructions]\n{{summary}}\n[End earlier story continuity]`;
const LEGACY_DEFAULT_INJECTION_TEMPLATE = `[Compacted conversation context — authoritative memory of earlier messages]\n{{summary}}\n[End compacted conversation context]`;
const LEGACY_DEFAULT_PROMPT = `You are compacting a long SillyTavern conversation into a dense continuation state.

Create a self-contained memory that lets the next model continue as if it had read the omitted conversation. Preserve information that can affect future replies, especially:
- explicit user instructions, preferences, constraints, style/roleplay rules, and standing requests;
- identities, relationships, character/world state, locations, inventory, timelines, and other continuity facts;
- goals, decisions, plans, promises, rationale, progress, completed work, current work, and remaining work;
- exact names, numbers, dates, paths, URLs, commands, code/API contracts, configuration values, and other details where precision matters;
- important discoveries, corrections, errors, failed attempts, blockers, warnings, and unresolved questions;
- the latest state of any artifact, project, story, analysis, or task.

Treat PREVIOUS COMPACTED CONTEXT as older memory and NEW TRANSCRIPT as newer evidence. When they conflict, prefer the newer transcript. Remove repetition and transient chatter, but do not discard details that may matter later. Do not invent facts. Do not answer the conversation and do not comment on the act of summarizing.

Output only the compacted continuation context, with useful headings/bullets when they improve density. Keep it within approximately {{target_tokens}} tokens.`;

const DEFAULT_SETTINGS = Object.freeze({
    schemaVersion: 2,
    autoEnabled: true,
    showMarker: true,
    contextPresetTokens: 0,
    triggerPercent: DEFAULT_TRIGGER_PERCENT,
    keepRecentTokens: 24000,
    summaryTargetTokens: 8192,
    maxInputTokens: 160000,
    minNewMessagesBetweenAutoCompacts: 3,
    prompt: DEFAULT_PROMPT,
    injectionTemplate: DEFAULT_INJECTION_TEMPLATE,
    goal: DEFAULT_GOAL_SETTINGS,
});

let initialized = false;
let inCompaction = false;
let activeGoalPopup = null;
let goalActionRunning = false;
let goalStopRequested = false;
let activePromptObservation = null;
const promptObservations = new Map();
let staticPromptTokenCache = { identity: '', source: '', tokens: 0 };

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

function showTaskNotice(title, message, { onStop = null } = {}) {
    let host = document.querySelector('#cc-compact-task-notices');
    if (!(host instanceof HTMLElement)) {
        host = document.createElement('div');
        host.id = 'cc-compact-task-notices';
        host.setAttribute('aria-live', 'polite');
        document.body.append(host);
    }

    const notice = document.createElement('div');
    notice.className = 'cc-compact-task-notice';
    const spinner = document.createElement('i');
    spinner.className = 'fa-solid fa-spinner fa-spin';
    const text = document.createElement('span');
    const heading = document.createElement('b');
    const detail = document.createElement('small');
    heading.textContent = title;
    detail.textContent = message;
    text.append(heading, detail);
    notice.append(spinner, text);
    if (typeof onStop === 'function') {
        const stopButton = document.createElement('button');
        stopButton.className = 'menu_button cc-compact-task-stop';
        stopButton.type = 'button';
        stopButton.textContent = 'Stop';
        stopButton.addEventListener('click', onStop);
        notice.append(stopButton);
    }
    host.append(notice);

    return {
        update(nextMessage) {
            detail.textContent = String(nextMessage || '');
        },
        hide() {
            notice.remove();
            if (!host.childElementCount) host.remove();
        },
    };
}

async function withTemporaryReasoningDisabled(context, disabled, callback) {
    if (!disabled) return await callback();

    const changes = [];
    const override = (target, key, value) => {
        if (!target || typeof target !== 'object') return;
        changes.push({ target, key, hadOwn: Object.hasOwn(target, key), previous: target[key] });
        target[key] = value;
    };

    override(context.chatCompletionSettings, 'reasoning_effort', 'none');
    override(context.chatCompletionSettings, 'show_thoughts', false);
    override(context.textCompletionSettings, 'include_reasoning', false);

    try {
        return await callback();
    } finally {
        for (const change of changes.reverse()) {
            if (change.hadOwn) change.target[change.key] = change.previous;
            else delete change.target[change.key];
        }
    }
}

function nearestContextPresetForThreshold(thresholdTokens, triggerPercent = DEFAULT_TRIGGER_PERCENT) {
    const threshold = Number(thresholdTokens);
    if (!Number.isFinite(threshold) || threshold <= 0) return 0;
    const desiredContext = threshold / (clampNumber(triggerPercent, 50, 98, DEFAULT_TRIGGER_PERCENT) / 100);
    return CONTEXT_PRESETS.reduce((nearest, preset) => (
        Math.abs(preset - desiredContext) < Math.abs(nearest - desiredContext) ? preset : nearest
    ), CONTEXT_PRESETS[0]);
}

function getSettings() {
    const context = SillyTavern.getContext();
    const root = context.extensionSettings;
    let changed = false;
    if (!root[MODULE_KEY] || typeof root[MODULE_KEY] !== 'object') {
        root[MODULE_KEY] = clone(DEFAULT_SETTINGS);
        changed = true;
    }

    // v1 stored an absolute trigger threshold. Migrate it to the nearest
    // context-window preset while keeping the new 90% policy predictable.
    if (root[MODULE_KEY].contextPresetTokens === undefined) {
        root[MODULE_KEY].contextPresetTokens = nearestContextPresetForThreshold(root[MODULE_KEY].thresholdTokens);
        changed = true;
    }
    if (root[MODULE_KEY].triggerPercent === undefined) {
        root[MODULE_KEY].triggerPercent = DEFAULT_TRIGGER_PERCENT;
        changed = true;
    }
    if (root[MODULE_KEY].schemaVersion === undefined || root[MODULE_KEY].schemaVersion < 2) {
        if (root[MODULE_KEY].prompt === LEGACY_DEFAULT_PROMPT) {
            root[MODULE_KEY].prompt = DEFAULT_PROMPT;
        }
        if (root[MODULE_KEY].injectionTemplate === LEGACY_DEFAULT_INJECTION_TEMPLATE) {
            root[MODULE_KEY].injectionTemplate = DEFAULT_INJECTION_TEMPLATE;
        }
        root[MODULE_KEY].schemaVersion = 2;
        changed = true;
    }

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (root[MODULE_KEY][key] === undefined) {
            root[MODULE_KEY][key] = clone(value);
            changed = true;
        }
    }

    if (changed && typeof context.saveSettingsDebounced === 'function') {
        setTimeout(() => context.saveSettingsDebounced(), 0);
    }

    return root[MODULE_KEY];
}

function getGoalSettings() {
    const settings = getSettings();
    if (!settings.goal || typeof settings.goal !== 'object' || Array.isArray(settings.goal)) {
        settings.goal = clone(DEFAULT_GOAL_SETTINGS);
    }
    for (const [key, value] of Object.entries(DEFAULT_GOAL_SETTINGS)) {
        if (settings.goal[key] === undefined) settings.goal[key] = clone(value);
    }
    if (!['random', 'builtin', 'custom'].includes(settings.goal.mode)) {
        settings.goal.mode = DEFAULT_GOAL_SETTINGS.mode;
    }
    return settings.goal;
}

function defaultChatState() {
    const settings = getSettings();
    return {
        version: 2,
        summary: '',
        compactionCount: 0,
        lastCompactedAt: null,
        lastTrigger: null,
        lastTokensBefore: null,
        lastAutoVisibleCount: 0,
        autoSnoozeUntilVisibleCount: 0,
        overridesEnabled: false,
        overrides: {
            contextPresetTokens: settings.contextPresetTokens,
            triggerPercent: settings.triggerPercent,
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

    let changed = state.version !== 2;
    const defaults = defaultChatState();
    for (const [key, value] of Object.entries(defaults)) {
        if (state[key] === undefined) {
            state[key] = clone(value);
            changed = true;
        }
    }
    if (!state.overrides || typeof state.overrides !== 'object') {
        state.overrides = clone(defaults.overrides);
        changed = true;
    }
    if (state.overrides.contextPresetTokens === undefined) {
        state.overrides.contextPresetTokens = nearestContextPresetForThreshold(state.overrides.thresholdTokens);
        changed = true;
    }
    if (state.overrides.triggerPercent === undefined) {
        state.overrides.triggerPercent = DEFAULT_TRIGGER_PERCENT;
        changed = true;
    }
    for (const [key, value] of Object.entries(defaults.overrides)) {
        if (state.overrides[key] === undefined) {
            state.overrides[key] = clone(value);
            changed = true;
        }
    }
    state.version = 2;
    if (changed && typeof context.saveMetadataDebounced === 'function') {
        setTimeout(() => context.saveMetadataDebounced(), 0);
    }
    return state;
}

function resolveContextWindowTokens(source, maxPromptTokens = null) {
    const configured = clampNumber(source.contextPresetTokens, 0, 10000000, 0);
    if (configured > 0) return configured;

    const context = SillyTavern.getContext();
    const tavernContext = Number(context.maxContext);
    if (Number.isFinite(tavernContext) && tavernContext > 0) return Math.round(tavernContext);

    const promptBudget = Number(maxPromptTokens);
    if (Number.isFinite(promptBudget) && promptBudget > 0) return Math.round(promptBudget);
    try {
        const fallback = Number(getMaxPromptTokens());
        if (Number.isFinite(fallback) && fallback > 0) return Math.round(fallback);
    } catch {
        // Fall through to the safest built-in preset.
    }
    return CONTEXT_PRESETS[0];
}

function getEffectiveSettings(maxPromptTokens = null) {
    const global = getSettings();
    const state = getChatState(false);
    const source = state?.overridesEnabled ? { ...global, ...state.overrides } : global;

    let promptBudget = Number(maxPromptTokens);
    if (!Number.isFinite(promptBudget) || promptBudget <= 0) {
        try {
            promptBudget = Number(getMaxPromptTokens());
        } catch {
            promptBudget = NaN;
        }
    }

    const contextWindowTokens = resolveContextWindowTokens(source, promptBudget);
    const triggerPercent = clampNumber(source.triggerPercent, 50, 98, DEFAULT_TRIGGER_PERCENT);
    const configuredThreshold = Math.max(1000, Math.round(contextWindowTokens * triggerPercent / 100));
    const promptSafetyThreshold = Number.isFinite(promptBudget) && promptBudget > 0
        ? Math.max(1000, Math.floor(promptBudget * 0.98))
        : configuredThreshold;
    const thresholdTokens = Math.min(configuredThreshold, promptSafetyThreshold);

    // Defaults scale down automatically on smaller contexts so a compact pass
    // always creates meaningful headroom instead of replacing history with an
    // oversized recent tail or summary.
    const sizingContextTokens = Number.isFinite(promptBudget) && promptBudget > 0
        ? Math.min(contextWindowTokens, promptBudget)
        : contextWindowTokens;
    const keepRecentCap = Math.max(2048, Math.round(sizingContextTokens * 0.18));
    const summaryTargetCap = Math.max(1024, Math.round(sizingContextTokens * 0.04));
    const keepRecentTokens = Math.min(
        clampNumber(source.keepRecentTokens, 0, 2000000, DEFAULT_SETTINGS.keepRecentTokens),
        keepRecentCap,
    );
    const summaryTargetTokens = Math.min(
        clampNumber(source.summaryTargetTokens, 256, 131072, DEFAULT_SETTINGS.summaryTargetTokens),
        summaryTargetCap,
    );

    return {
        autoEnabled: Boolean(global.autoEnabled),
        showMarker: Boolean(global.showMarker),
        contextPresetTokens: clampNumber(source.contextPresetTokens, 0, 10000000, 0),
        contextWindowTokens,
        triggerPercent,
        thresholdTokens,
        keepRecentTokens,
        summaryTargetTokens,
        maxInputTokens: clampNumber(source.maxInputTokens, 4096, 4000000, DEFAULT_SETTINGS.maxInputTokens),
        minNewMessagesBetweenAutoCompacts: clampNumber(global.minNewMessagesBetweenAutoCompacts, 1, 100, DEFAULT_SETTINGS.minNewMessagesBetweenAutoCompacts),
        prompt: String(source.prompt || DEFAULT_PROMPT),
        injectionTemplate: String(global.injectionTemplate || DEFAULT_INJECTION_TEMPLATE).includes('{{summary}}')
            ? String(global.injectionTemplate)
            : DEFAULT_INJECTION_TEMPLATE,
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

function syncSummaryInjection(activeChat = null) {
    const state = getChatState(false);
    const settings = getEffectiveSettings();
    const summary = String(state?.summary || '').trim();
    const value = summary
        ? settings.injectionTemplate.replaceAll('{{summary}}', summary)
        : '';

    // A compacted state is replacement history, not a generic top-level instruction.
    // Inject it as a real SYSTEM message immediately before the active (uncompacted)
    // chat tail. Depth 0 is the newest message; therefore active-message count puts
    // the compact state at the oldest edge of the retained working set.
    const activeDepth = Array.isArray(activeChat)
        ? activeChat.filter(message => message && !message.is_system && String(message.mes || '').trim()).length
        : visibleEntries().length;
    const depth = Math.min(10000, Math.max(0, activeDepth));
    setExtensionPrompt(PROMPT_ID, value, extension_prompt_types.IN_CHAT, depth, false, extension_prompt_roles.SYSTEM);
}

async function estimateActiveContextTokens(activeChat, previousSummary = '') {
    const transcript = (Array.isArray(activeChat) ? activeChat : [])
        .filter(message => message && !message.is_system && String(message.mes || '').trim())
        .map((message, index) => transcriptEntry(message, index))
        .join('\n\n');
    const summary = String(previousSummary || '').trim();
    const combined = summary
        ? `PREVIOUS COMPACTED CONTEXT:\n${summary}\n\nACTIVE CHAT:\n${transcript}`
        : transcript;
    return await countTokens(combined);
}

function staticPromptSource() {
    const context = SillyTavern.getContext();
    const values = new Set();
    try {
        const fields = context.getCharacterCardFields?.() || {};
        for (const key of ['description', 'personality', 'persona', 'scenario', 'mesExamples', 'charDepthPrompt', 'creatorNotes']) {
            const value = String(fields[key] || '').trim();
            if (value) values.add(value);
        }
    } catch (error) {
        console.debug(`${LOG_PREFIX} Could not inspect character prompt fields.`, error);
    }

    for (const [key, prompt] of Object.entries(context.extensionPrompts || {})) {
        if (key === PROMPT_ID) continue;
        const value = String(prompt?.value || '').trim();
        if (value) values.add(value);
    }
    return [...values].join('\n\n');
}

async function estimateStaticPromptTokens() {
    const identity = getChatIdentity();
    const source = staticPromptSource();
    if (staticPromptTokenCache.identity === identity && staticPromptTokenCache.source === source) {
        return staticPromptTokenCache.tokens;
    }
    const tokens = await countTokens(source);
    staticPromptTokenCache = { identity, source, tokens };
    return tokens;
}

function stringifyObservedPrompt(prompt) {
    if (typeof prompt === 'string') return prompt;
    if (!Array.isArray(prompt)) return '';
    return prompt.map((message) => {
        if (!message || typeof message !== 'object') return String(message || '');
        const role = String(message.role || message.name || 'message');
        const content = typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content ?? '');
        const tools = message.tool_calls ? `\n${JSON.stringify(message.tool_calls)}` : '';
        return `${role}: ${content}${tools}`;
    }).join('\n\n');
}

function observeFinalPrompt(prompt, dryRun = false) {
    if (dryRun || inCompaction || !activePromptObservation || document.body.dataset.generating !== 'true') return;
    const promptText = stringifyObservedPrompt(prompt);
    if (!promptText.trim()) return;

    const observation = { ...activePromptObservation };
    const context = SillyTavern.getContext();
    const chatSnapshot = (context.chat || []).map(message => ({
        name: message?.name,
        mes: message?.mes,
        is_user: message?.is_user,
        is_system: message?.is_system,
    }));
    const summarySnapshot = String(getChatState(false)?.summary || '');

    setTimeout(async () => {
        try {
            const [promptTokens, activeTokens] = await Promise.all([
                countTokens(promptText),
                estimateActiveContextTokens(chatSnapshot, summarySnapshot),
            ]);
            promptObservations.set(observation.identity, {
                promptTokens,
                activeTokens,
                overheadTokens: Math.max(0, promptTokens - activeTokens),
                type: observation.type,
                observedAt: Date.now(),
            });
        } catch (error) {
            console.debug(`${LOG_PREFIX} Could not observe finalized prompt size.`, error);
        }
    }, 0);
}

async function validateCompactedSummary(summary, sourceText) {
    const value = String(summary || '').trim();
    if (!value) throw new Error('The model returned an empty compacted context. Original messages were not hidden.');

    const [summaryTokens, sourceTokens] = await Promise.all([countTokens(value), countTokens(sourceText)]);
    const refusalPatterns = [
        /(?:当前|本轮|这段|上述).{0,30}(?:没有|不存在|未提供|看不到).{0,30}(?:上下文|对话|内容|文本|原文)/i,
        /请.{0,30}(?:重新发送|补充|提供).{0,30}(?:原文|内容|文本|上下文)/i,
        /I\s+(?:do\s+not|don't|cannot|can't)\s+(?:have|see|access).{0,50}(?:context|conversation|text|content)/i,
        /(?:not present|not available|does not exist).{0,50}(?:context|conversation|history)/i,
    ];

    if (refusalPatterns.some(pattern => pattern.test(value))) {
        throw new Error('The model answered as if the transcript were missing instead of compacting it. Original messages were not hidden.');
    }
    if (sourceTokens >= 2000 && summaryTokens < 64) {
        throw new Error(`The compacted context is implausibly short (${summaryTokens} tokens for ~${sourceTokens} source tokens). Original messages were not hidden.`);
    }
    return { summaryTokens, sourceTokens };
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
        const sourceText = chunks[i];
        const prompt = [
            { role: 'system', content: previous },
            { role: 'user', content: `NEW TRANSCRIPT TO FOLD IN (chunk ${i + 1}/${chunks.length}):\n${sourceText}` },
        ];
        const raw = await context.generateRaw({
            prompt,
            systemPrompt,
            responseLength: settings.summaryTargetTokens,
            trimNames: false,
        });
        running = removeReasoningFromString(String(raw || '')).trim();
        await validateCompactedSummary(running, sourceText);
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
        if (manual) toastr.info(message, 'CC Compact');
        return { success: false, reason: 'nothing-to-fold', message };
    }

    let taskNotice = null;
    try {
        inCompaction = true;
        taskNotice = showTaskNotice(
            'CC Compact',
            trigger === 'automatic' ? 'Automatically compacting context…' : 'Compacting context…',
        );

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
        if (manual) toastr.success(`Folded ${fold.length} messages into ~${summaryTokens.toLocaleString()} tokens.`, 'CC Compact');
        return result;
    } catch (error) {
        console.error(`${LOG_PREFIX} Compaction failed`, error);
        toastr.error(String(error?.message || error), 'CC Compact failed');
        return { success: false, reason: 'error', message: String(error?.message || error) };
    } finally {
        inCompaction = false;
        taskNotice?.hide();
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
    toastr.success(`Restored ${restored} message${restored === 1 ? '' : 's'} to model context.`, 'CC Compact reset');
    return restored;
}

async function statusText() {
    const settings = getEffectiveSettings();
    const state = getChatState(false);
    const summaryTokens = state?.summary ? await countTokens(state.summary) : 0;
    const hidden = hiddenByCompactCount();
    const observedOverhead = Number(promptObservations.get(getChatIdentity())?.overheadTokens || 0);
    return `CC Compact: auto=${settings.autoEnabled ? 'on' : 'off'}, context=${settings.contextWindowTokens}, trigger=${settings.triggerPercent}% (~${settings.thresholdTokens}), observed non-chat≈${observedOverhead}, hidden=${hidden}, summary≈${summaryTokens}, compactions=${state?.compactionCount || 0}, last=${state?.lastTrigger || 'never'}.`;
}

function parseGoalPrompts(value) {
    return String(value || '')
        .split(/\r?\n/)
        .map(prompt => prompt.trim())
        .filter(Boolean);
}

function pickGoalPrompt(prompts, previousPrompt = '') {
    const alternatives = prompts.length > 1
        ? prompts.filter(prompt => prompt !== previousPrompt)
        : prompts;
    const pool = alternatives.length ? alternatives : prompts;
    return pool[Math.floor(Math.random() * pool.length)] || '';
}

function setGoalComposerText(text) {
    const composer = document.querySelector('#send_textarea');
    if (!(composer instanceof HTMLTextAreaElement)) {
        throw new Error('SillyTavern message input was not found.');
    }
    composer.value = String(text || '').trim();
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    composer.focus();
    return composer.value;
}

async function sendGoalComposerText() {
    await new Promise(resolve => requestAnimationFrame(() => resolve()));
    if (goalStopRequested) return;
    const sendButton = document.querySelector('#send_but');
    if (!(sendButton instanceof HTMLElement)) {
        throw new Error('SillyTavern send button was not found.');
    }
    if (document.body.dataset.generating === 'true'
        || sendButton.classList.contains('disabled')
        || sendButton.getAttribute('aria-disabled') === 'true') {
        throw new Error('SillyTavern is still generating or is not connected. The Goal draft was left in the input box.');
    }
    sendButton.click();

    // The click handler starts Generate() asynchronously. Wait until the
    // generation lock clears before allowing the next Goal round to begin.
    const startedAt = Date.now();
    while (document.body.dataset.generating !== 'true' && Date.now() - startedAt < 1500) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (document.body.dataset.generating !== 'true') return;

    let stopIssued = false;
    while (document.body.dataset.generating === 'true') {
        if (goalStopRequested) {
            if (!stopIssued) {
                SillyTavern.getContext().stopGeneration?.();
                stopIssued = true;
            }
        }
        if (Date.now() - startedAt > 30 * 60 * 1000) {
            throw new Error('Timed out waiting for the character reply to finish.');
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

function buildGoalLiteTranscript() {
    const context = SillyTavern.getContext();
    const messages = (context.chat || [])
        .filter(message => message
            && !message.extra?.compact_marker
            && !message.extra?.compact_hidden
            && !message.is_system
            && String(message.mes || '').trim());

    const selected = [];
    let usedCharacters = 0;
    for (let index = messages.length - 1; index >= 0 && selected.length < 4; index--) {
        const message = messages[index];
        const speaker = message.is_user ? 'U' : 'A';
        const body = String(message.mes).trim();
        const separatorLength = selected.length ? 1 : 0;
        const remaining = GOAL_LITE_INPUT_CHAR_BUDGET - usedCharacters - 2 - separatorLength;
        if (remaining <= 0) break;
        const excerpt = body.length > remaining
            ? (remaining === 1 ? '…' : `…${body.slice(-(remaining - 1))}`)
            : body;
        selected.unshift(`${speaker}:${excerpt}`);
        usedCharacters += excerpt.length + 2 + separatorLength;
    }
    return selected.join('\n');
}

async function runGoalRound(actionSettings, previewPrompt = '', taskNotice = null) {
    const context = SillyTavern.getContext();
    if (!context.chatId && !context.groupId && context.characterId == null) {
        throw new Error('Open a chat before using /goal.');
    }

    const identity = getChatIdentity(context);
    const mode = actionSettings.mode;
    let draft = '';

    if (goalStopRequested) return { stopped: true };
    const message = mode === 'random'
        ? 'Selecting a saved prompt…'
        : `Drafting the next user message${actionSettings.disableReasoning ? ' without reasoning' : ''}…`;
    taskNotice?.update(message);

    if (mode === 'random') {
        const prompts = parseGoalPrompts(actionSettings.randomPrompts);
        if (!prompts.length) throw new Error('The random prompt library is empty. Add at least one prompt in /goal.');
        draft = prompts.includes(previewPrompt)
            ? previewPrompt
            : pickGoalPrompt(prompts, actionSettings.lastRandomPrompt);
        const currentGoalSettings = getGoalSettings();
        currentGoalSettings.lastRandomPrompt = draft;
        SillyTavern.getContext().saveSettingsDebounced();
    } else if (mode === 'builtin') {
        setGoalComposerText('');
        const prompt = String(actionSettings.builtinPrompt || '').trim();
        const options = prompt ? { quiet_prompt: prompt, quietToLoud: true } : {};
        await withTemporaryReasoningDisabled(
            context,
            Boolean(actionSettings.disableReasoning),
            () => Generate('impersonate', options),
        );
        draft = String(document.querySelector('#send_textarea')?.value || '').trim();
        if (!draft) throw new Error('SillyTavern impersonate returned an empty message.');
    } else if (mode === 'custom') {
        if (typeof context.generateRaw !== 'function') {
            throw new Error('SillyTavern generateRaw() is unavailable. Update SillyTavern to a current release.');
        }
        const recentTranscript = buildGoalLiteTranscript();
        if (!recentTranscript) throw new Error('There is no recent conversation to reply to.');
        const raw = await withTemporaryReasoningDisabled(
            context,
            Boolean(actionSettings.disableReasoning),
            () => context.generateRaw({
                prompt: recentTranscript,
                systemPrompt: GOAL_LITE_SYSTEM_PROMPT,
                trimNames: true,
            }),
        );
        draft = String(raw || '').trim();
        if (!draft) throw new Error('Custom impersonate returned an empty message.');
    } else {
        throw new Error(`Unknown Goal mode: ${mode}`);
    }

    if (getChatIdentity(SillyTavern.getContext()) !== identity) {
        throw new Error('The chat changed while Goal was running; the generated message was discarded.');
    }

    setGoalComposerText(draft);
    if (goalStopRequested) return { stopped: true };
    if (actionSettings.autoSend) {
        taskNotice?.update('Waiting for the character reply to finish…');
        await sendGoalComposerText();
    } else {
        toastr.info('Goal draft placed in the message input. Auto-send is off; stop Goal when ready.', 'CC Goal');
    }
    return { success: true };
}

async function runGoalLoop(actionSettings, previewPrompt = '') {
    if (goalActionRunning) {
        toastr.warning('A Goal loop is already running.', 'CC Goal');
        return;
    }

    goalActionRunning = true;
    goalStopRequested = false;
    let rounds = 0;
    const taskNotice = showTaskNotice(
        'CC Goal',
        'Starting continuous Goal loop…',
        { onStop: requestGoalStop },
    );

    try {
        while (!goalStopRequested) {
            rounds++;
            const result = await runGoalRound(actionSettings, previewPrompt, taskNotice);
            previewPrompt = '';
            if (!result?.success || result?.stopped) break;
            if (!actionSettings.autoSend) {
                taskNotice.update(`Round ${rounds} complete · draft replaced in input; click Stop to finish.`);
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    } catch (error) {
        if (!goalStopRequested) {
            console.error(`${LOG_PREFIX} Goal loop failed`, error);
            toastr.error(String(error?.message || error), 'CC Goal failed');
        }
    } finally {
        taskNotice.hide();
        goalActionRunning = false;
        const stopped = goalStopRequested;
        goalStopRequested = false;
        if (stopped) {
            toastr.info(`Goal stopped after ${rounds} round${rounds === 1 ? '' : 's'}.`, 'CC Goal');
        }
    }
}

function requestGoalStop() {
    if (!goalActionRunning) return false;
    goalStopRequested = true;
    if (document.body.dataset.generating === 'true') {
        SillyTavern.getContext().stopGeneration?.();
    }
    return true;
}

function openGoalPopup() {
    if (activeGoalPopup?.isConnected) {
        activeGoalPopup.querySelector('#cc-goal-run')?.focus();
        return;
    }

    const settings = getGoalSettings();
    const overlay = $(`
        <div class="cc-goal-overlay" role="presentation">
            <div class="cc-goal-dialog" role="dialog" aria-modal="false" aria-labelledby="cc-goal-title">
                <button class="cc-goal-close menu_button" type="button" aria-label="Close Goal">
                    <i class="fa-solid fa-xmark"></i>
                </button>
                <div class="cc-goal-panel">
            <div class="cc-goal-intro">
                <h3 id="cc-goal-title"><i class="fa-solid fa-bullseye"></i> Goal</h3>
                <p>Choose how to create the next user message. All fields below are saved globally.</p>
            </div>
            <div class="cc-goal-mode-list" role="radiogroup" aria-label="Goal mode">
                <label class="cc-goal-mode-card">
                    <input type="radio" name="cc-goal-mode" value="random">
                    <span><b>Random prompt</b><small>Pick one saved line and use it as the user message.</small></span>
                </label>
                <label class="cc-goal-mode-card">
                    <input type="radio" name="cc-goal-mode" value="builtin">
                    <span><b>SillyTavern impersonate</b><small>Use SillyTavern's native character, lore and prompt pipeline.</small></span>
                </label>
                <label class="cc-goal-mode-card">
                    <input type="radio" name="cc-goal-mode" value="custom">
                    <span><b>CC impersonate</b><small>One low-token request using only recent conversation context.</small></span>
                </label>
            </div>

            <section class="cc-goal-mode-panel" data-goal-panel="random">
                <label for="cc-goal-random-prompts"><b>Prompt library</b></label>
                <textarea id="cc-goal-random-prompts" class="text_pole" rows="9" placeholder="One prompt per line\nFor example: Ask about the locked door\nSuggest moving to the next location"></textarea>
                <div class="cc-goal-inline-actions">
                    <small id="cc-goal-prompt-count" class="compact-muted"></small>
                    <button id="cc-goal-preview-button" class="menu_button" type="button">
                        <i class="fa-solid fa-shuffle"></i> Draw preview
                    </button>
                </div>
                <textarea id="cc-goal-preview" class="text_pole" rows="3" readonly placeholder="The drawn prompt will appear here."></textarea>
            </section>

            <section class="cc-goal-mode-panel" data-goal-panel="builtin">
                <label for="cc-goal-builtin-prompt"><b>Optional additional instruction</b></label>
                <textarea id="cc-goal-builtin-prompt" class="text_pole" rows="5" placeholder="Leave empty to use the native impersonate prompt unchanged."></textarea>
                <small class="compact-muted">This mode calls SillyTavern's own <code>Generate('impersonate')</code>.</small>
            </section>

            <section class="cc-goal-mode-panel" data-goal-panel="custom">
                <b>Lightweight CC impersonate</b>
                <p>Uses only a small recent-chat excerpt and one lightweight request, then uses the returned response content directly.</p>
                <small class="compact-muted">Input is capped at 800 characters. Reasoning and response length use the active SillyTavern/model settings without truncation.</small>
            </section>

            <label class="checkbox_label cc-goal-reasoning-option" for="cc-goal-disable-reasoning">
                <input id="cc-goal-disable-reasoning" type="checkbox">
                <span><b>Disable reasoning for impersonate requests</b><small>Saved as a Goal-only preference. The active backend must support reasoning_effort=none.</small></span>
            </label>

            <label class="checkbox_label cc-goal-auto-send" for="cc-goal-auto-send">
                <input id="cc-goal-auto-send" type="checkbox">
                <span>Send immediately and generate the character reply</span>
            </label>
            <small class="compact-muted">If disabled, the selected/generated message is left in the input box for editing.</small>

            <div class="cc-goal-run-row">
                <button id="cc-goal-stop" class="menu_button" type="button">Stop Goal</button>
                <button id="cc-goal-run" class="menu_button menu_button_icon" type="button">
                    <i class="fa-solid fa-play"></i><span>Run Goal</span>
                </button>
            </div>
                </div>
            </div>
        </div>
    `);
    const content = overlay.find('.cc-goal-panel');
    const closeGoalPopup = () => {
        $(document).off('keydown.ccGoal');
        overlay.remove();
        if (activeGoalPopup === overlay[0]) activeGoalPopup = null;
    };
    activeGoalPopup = overlay[0];

    content.find(`input[name="cc-goal-mode"][value="${settings.mode}"]`).prop('checked', true);
    content.find('#cc-goal-random-prompts').val(settings.randomPrompts);
    content.find('#cc-goal-builtin-prompt').val(settings.builtinPrompt);
    content.find('#cc-goal-disable-reasoning').prop('checked', Boolean(settings.disableReasoning));
    content.find('#cc-goal-auto-send').prop('checked', Boolean(settings.autoSend));

    const refreshPromptCount = () => {
        const count = parseGoalPrompts(content.find('#cc-goal-random-prompts').val()).length;
        content.find('#cc-goal-prompt-count').text(`${count} saved prompt${count === 1 ? '' : 's'}`);
    };
    const refreshMode = () => {
        const mode = String(content.find('input[name="cc-goal-mode"]:checked').val() || 'random');
        content.find('.cc-goal-mode-card').toggleClass('cc-goal-mode-selected', false);
        content.find(`input[name="cc-goal-mode"][value="${mode}"]`).closest('.cc-goal-mode-card').addClass('cc-goal-mode-selected');
        content.find('.cc-goal-mode-panel').hide();
        content.find(`.cc-goal-mode-panel[data-goal-panel="${mode}"]`).show();
        content.find('.cc-goal-reasoning-option').toggle(mode !== 'random');
        const labels = { random: 'Draw and run', builtin: 'Run native impersonate', custom: 'Run CC impersonate' };
        content.find('#cc-goal-run span').text(labels[mode]);
        content.find('#cc-goal-stop').prop('disabled', !goalActionRunning);
    };
    const persistUi = () => {
        const goal = getGoalSettings();
        goal.mode = String(content.find('input[name="cc-goal-mode"]:checked').val() || 'random');
        goal.randomPrompts = String(content.find('#cc-goal-random-prompts').val() || '');
        goal.builtinPrompt = String(content.find('#cc-goal-builtin-prompt').val() || '');
        goal.disableReasoning = Boolean(content.find('#cc-goal-disable-reasoning').prop('checked'));
        goal.autoSend = Boolean(content.find('#cc-goal-auto-send').prop('checked'));
        SillyTavern.getContext().saveSettingsDebounced();
    };
    const persistUiDebounced = debounce(persistUi, 350);

    content.find('input[name="cc-goal-mode"]').on('change', () => {
        refreshMode();
        persistUi();
    });
    content.find('#cc-goal-random-prompts').on('input', () => {
        content.find('#cc-goal-preview').val('');
        refreshPromptCount();
        persistUiDebounced();
    });
    content.find('#cc-goal-builtin-prompt').on('input', persistUiDebounced);
    content.find('#cc-goal-disable-reasoning').on('change', persistUi);
    content.find('#cc-goal-auto-send').on('change', persistUi);
    content.find('#cc-goal-preview-button').on('click', () => {
        const prompts = parseGoalPrompts(content.find('#cc-goal-random-prompts').val());
        if (!prompts.length) {
            toastr.warning('Add at least one line to the prompt library.', 'CC Goal');
            return;
        }
        const preview = pickGoalPrompt(prompts, String(content.find('#cc-goal-preview').val() || settings.lastRandomPrompt));
        content.find('#cc-goal-preview').val(preview);
    });
    content.find('#cc-goal-run').on('click', () => {
        persistUi();
        const actionSettings = clone(getGoalSettings());
        if (actionSettings.mode === 'random' && !parseGoalPrompts(actionSettings.randomPrompts).length) {
            toastr.warning('Add at least one line to the prompt library.', 'CC Goal');
            return;
        }
        const preview = String(content.find('#cc-goal-preview').val() || '').trim();
        closeGoalPopup();
        setTimeout(() => runGoalLoop(actionSettings, preview), 50);
    });
    content.find('#cc-goal-stop').on('click', requestGoalStop);

    refreshPromptCount();
    refreshMode();
    overlay.find('.cc-goal-close').on('click', closeGoalPopup);
    overlay.on('mousedown', (event) => {
        if (event.target === overlay[0]) closeGoalPopup();
    });
    $(document).off('keydown.ccGoal').on('keydown.ccGoal', (event) => {
        if (event.key === 'Escape') closeGoalPopup();
    });
    document.body.append(overlay[0]);
    content.find('#cc-goal-run')[0]?.focus();
}

// SillyTavern calls this before it finishes assembling the outgoing prompt.
// The second argument is the prompt budget, not current usage. The finalized
// request is token-counted separately so injected overhead can be budgeted on
// the next turn without retaining or summarizing any preset text.
globalThis.CompactGenerationInterceptor = async function CompactGenerationInterceptor(chat, maxPromptTokens, _abort, type) {
    if (inCompaction || type === 'quiet') return;

    // Re-anchor an existing compact state before every generation so it always sits
    // immediately before the retained/new chat tail, even as that tail grows.
    syncSummaryInjection(chat);

    const settings = getEffectiveSettings(maxPromptTokens);
    if (!settings.autoEnabled) return;

    const state = getChatState(true);
    const [chatTokens, staticPromptTokens] = await Promise.all([
        estimateActiveContextTokens(chat, state.summary),
        estimateStaticPromptTokens(),
    ]);
    const observed = promptObservations.get(getChatIdentity());
    const overheadTokens = Math.max(staticPromptTokens, Number(observed?.overheadTokens || 0));
    const projectedTokens = chatTokens + overheadTokens;
    if (projectedTokens < settings.thresholdTokens) return;

    const visibleCount = Array.isArray(chat) ? chat.length : 0;
    const minimumGrowth = settings.minNewMessagesBetweenAutoCompacts;

    // These guards are deliberately conservative. They prevent a bad/verbose summary
    // from causing the same generation to fall into a repeated compact loop.
    if (state.autoSnoozeUntilVisibleCount && visibleCount < state.autoSnoozeUntilVisibleCount) return;
    if (state.lastAutoVisibleCount && visibleCount < state.lastAutoVisibleCount + minimumGrowth) return;

    const result = await compactContext('automatic', { tokensBefore: projectedTokens });
    if (!result.success) {
        state.autoSnoozeUntilVisibleCount = visibleCount + minimumGrowth;
        if (SillyTavern.getContext().saveMetadata) await SillyTavern.getContext().saveMetadata();
        return;
    }

    // Generate() snapshots coreChat before interceptors run. Remove newly folded entries
    // from that snapshot too, otherwise the trigger turn would still send the old history.
    if (Array.isArray(chat)) {
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i]?.extra?.compact_hidden) chat.splice(i, 1);
        }
    }
    syncSummaryInjection(chat);
};

function setDisabledState() {
    const enabled = $('#compact-chat-override-enabled').prop('checked');
    $('#compact-chat-overrides, #compact-chat-prompt').toggleClass('compact-disabled', !enabled);
    $('#compact-chat-overrides :input, #compact-chat-prompt').prop('disabled', !enabled);
    const customSelected = $('#compact-chat-context-preset').val() === 'custom';
    $('#compact-chat-context-custom').closest('label').toggle(customSelected);
    $('#compact-chat-context-custom').prop('disabled', !enabled || !customSelected);
}

function setContextPresetUi(selectSelector, customSelector, value) {
    const numeric = clampNumber(value, 0, 10000000, 0);
    const isPreset = numeric === 0 || CONTEXT_PRESETS.includes(numeric);
    $(selectSelector).val(isPreset ? String(numeric) : 'custom');
    $(customSelector).val(numeric > 0 ? numeric : '');
    if (customSelector === '#compact-context-custom') {
        $(customSelector).toggle(!isPreset);
    }
}

function updateThresholdPreview() {
    const settings = getSettings();
    let promptBudget = NaN;
    try {
        promptBudget = Number(getMaxPromptTokens());
    } catch {
        // Preview can still use the selected total context.
    }
    const contextWindow = resolveContextWindowTokens(settings, promptBudget);
    const percent = clampNumber(settings.triggerPercent, 50, 98, DEFAULT_TRIGGER_PERCENT);
    const configured = Math.round(contextWindow * percent / 100);
    const effective = Number.isFinite(promptBudget) && promptBudget > 0
        ? Math.min(configured, Math.floor(promptBudget * 0.98))
        : configured;
    const source = Number(settings.contextPresetTokens) > 0 ? 'selected context' : 'current SillyTavern context';
    const safety = effective < configured ? ' · capped by the active backend prompt limit' : '';
    $('#compact-threshold-preview').text(`Starts at ~${effective.toLocaleString()} tokens (${percent}% of ${contextWindow.toLocaleString()}, ${source})${safety}.`);
}

function loadGlobalUi() {
    const settings = getSettings();
    $('#compact-auto-enabled').prop('checked', Boolean(settings.autoEnabled));
    $('#compact-show-marker').prop('checked', Boolean(settings.showMarker));
    setContextPresetUi('#compact-context-preset', '#compact-context-custom', settings.contextPresetTokens);
    $('#compact-trigger-percent').val(settings.triggerPercent);
    $('#compact-keep-recent').val(settings.keepRecentTokens);
    $('#compact-summary-target').val(settings.summaryTargetTokens);
    $('#compact-max-input').val(settings.maxInputTokens);
    $('#compact-min-new-messages').val(settings.minNewMessagesBetweenAutoCompacts);
    $('#compact-prompt').val(settings.prompt);
    $('#compact-injection-template').val(settings.injectionTemplate);
    updateThresholdPreview();
}

async function updateChatUi() {
    const state = getChatState(false);
    const settings = getSettings();
    const overrides = state?.overrides || {
        contextPresetTokens: settings.contextPresetTokens,
        triggerPercent: settings.triggerPercent,
        keepRecentTokens: settings.keepRecentTokens,
        summaryTargetTokens: settings.summaryTargetTokens,
        maxInputTokens: settings.maxInputTokens,
        prompt: settings.prompt,
    };

    $('#compact-chat-override-enabled').prop('checked', Boolean(state?.overridesEnabled));
    setContextPresetUi('#compact-chat-context-preset', '#compact-chat-context-custom', overrides.contextPresetTokens);
    $('#compact-chat-trigger-percent').val(overrides.triggerPercent);
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

    $('#compact-context-preset').off('.compact').on('change.compact', function () {
        const settings = getSettings();
        const value = String($(this).val());
        if (value === 'custom') {
            const fallback = clampNumber(SillyTavern.getContext().maxContext, 4096, 10000000, CONTEXT_PRESETS[0]);
            const custom = clampNumber($('#compact-context-custom').val(), 4096, 10000000, fallback);
            $('#compact-context-custom').val(custom).show().focus();
            settings.contextPresetTokens = custom;
        } else {
            $('#compact-context-custom').hide();
            settings.contextPresetTokens = Number(value);
        }
        updateThresholdPreview();
        saveGlobal();
    });
    $('#compact-context-custom').off('.compact').on('input.compact', debounce(function () {
        getSettings().contextPresetTokens = clampNumber($(this).val(), 4096, 10000000, CONTEXT_PRESETS[0]);
        updateThresholdPreview();
        saveGlobal();
    }));

    const globalNumberBindings = [
        ['#compact-trigger-percent', 'triggerPercent'],
        ['#compact-keep-recent', 'keepRecentTokens'],
        ['#compact-summary-target', 'summaryTargetTokens'],
        ['#compact-max-input', 'maxInputTokens'],
        ['#compact-min-new-messages', 'minNewMessagesBetweenAutoCompacts'],
    ];
    for (const [selector, key] of globalNumberBindings) {
        $(selector).off('.compact').on('change.compact', function () {
            getSettings()[key] = Number($(this).val());
            if (key === 'triggerPercent') updateThresholdPreview();
            saveGlobal();
        });
    }

    $('#compact-prompt').off('.compact').on('input.compact', debounce(function () {
        getSettings().prompt = String($(this).val());
        saveGlobal();
    }));
    $('#compact-injection-template').off('.compact').on('input.compact', debounce(function () {
        const value = String($(this).val());
        getSettings().injectionTemplate = value;
        const valid = value.includes('{{summary}}');
        $(this).toggleClass('compact-invalid', !valid);
        syncSummaryInjection();
        saveGlobal();
    }));
    $('#compact-injection-template').off('change.compactValidation').on('change.compactValidation', function () {
        if (!String($(this).val()).includes('{{summary}}')) {
            toastr.warning('Injection template must contain {{summary}}. The default template will be used until this is fixed.', 'CC Compact');
        }
    });
    $('#compact-restore-prompt').off('.compact').on('click.compact', () => {
        getSettings().prompt = DEFAULT_PROMPT;
        $('#compact-prompt').val(DEFAULT_PROMPT);
        saveGlobal();
    });
    $('#compact-restore-injection').off('.compact').on('click.compact', () => {
        getSettings().injectionTemplate = DEFAULT_INJECTION_TEMPLATE;
        $('#compact-injection-template').val(DEFAULT_INJECTION_TEMPLATE);
        syncSummaryInjection();
        saveGlobal();
    });
    $('#compact-restore-all').off('.compact').on('click.compact', () => {
        const settings = getSettings();
        const goalSettings = clone(getGoalSettings());
        Object.assign(settings, clone(DEFAULT_SETTINGS));
        settings.goal = goalSettings;
        delete settings.thresholdTokens;
        loadGlobalUi();
        syncSummaryInjection();
        saveGlobal();
        toastr.success('Global Compact settings restored to defaults.', 'CC Compact');
    });

    $('#compact-chat-override-enabled').off('.compact').on('change.compact', async function () {
        const state = getChatState(true);
        state.overridesEnabled = Boolean($(this).prop('checked'));
        if (state.overridesEnabled && !state.overrides) state.overrides = clone(defaultChatState().overrides);
        setDisabledState();
        if (SillyTavern.getContext().saveMetadata) await SillyTavern.getContext().saveMetadata();
    });

    $('#compact-chat-context-preset').off('.compact').on('change.compact', function () {
        const state = getChatState(true);
        const value = String($(this).val());
        if (value === 'custom') {
            const fallback = clampNumber(SillyTavern.getContext().maxContext, 4096, 10000000, CONTEXT_PRESETS[0]);
            const custom = clampNumber($('#compact-chat-context-custom').val(), 4096, 10000000, fallback);
            $('#compact-chat-context-custom').val(custom);
            state.overrides.contextPresetTokens = custom;
        } else {
            state.overrides.contextPresetTokens = Number(value);
        }
        setDisabledState();
        saveChatDebounced();
    });
    $('#compact-chat-context-custom').off('.compact').on('input.compact', debounce(function () {
        const state = getChatState(true);
        state.overrides.contextPresetTokens = clampNumber($(this).val(), 4096, 10000000, CONTEXT_PRESETS[0]);
        saveChatDebounced();
    }));

    const chatNumberBindings = [
        ['#compact-chat-trigger-percent', 'triggerPercent'],
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
    $('#compact-open-goal').off('.compact').on('click.compact', openGoalPopup);
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
                toastr.info(text, 'CC Compact');
                return text;
            }
            if (action === 'reset') {
                await resetCurrentChat();
                return 'Compact state reset for this chat.';
            }
            if (action && action !== 'now') {
                const text = 'Usage: /compact, /compact status, or /compact reset';
                toastr.warning(text, 'CC Compact');
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

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'goal',
        callback: (_args, value) => {
            const action = String(value || '').trim().toLowerCase();
            if (action === 'stop') {
                const stopped = requestGoalStop();
                const text = stopped ? 'Goal stop requested.' : 'No Goal loop is running.';
                if (stopped) toastr.info(text, 'CC Goal');
                return text;
            }
            if (action) {
                const text = 'Usage: /goal or /goal stop';
                toastr.warning(text, 'CC Goal');
                return text;
            }
            openGoalPopup();
            return '';
        },
        namedArgumentList: [],
        unnamedArgumentList: [],
        helpString: 'Opens the Goal interface for a saved random prompt, SillyTavern native impersonate, or CC impersonate.',
        returns: ARGUMENT_TYPE.STRING,
    }));
}

async function initialize() {
    if (initialized) return;
    initialized = true;

    getSettings();
    const html = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');
    const container = $('#extensions_settings2, #extensions_settings').first();
    if (!container.length) {
        throw new Error('SillyTavern extension settings container was not found.');
    }
    if (!$('#compact-settings').length) container.append(html);

    loadGlobalUi();
    bindSettingsUi();
    registerSlashCommands();
    syncSummaryInjection();
    await updateChatUi();
    decorateMessages();

    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        activePromptObservation = null;
        staticPromptTokenCache = { identity: '', source: '', tokens: 0 };
        syncSummaryInjection();
        updateThresholdPreview();
        await updateChatUi();
        setTimeout(decorateMessages, 0);
    });
    if (event_types.SETTINGS_UPDATED) {
        eventSource.on(event_types.SETTINGS_UPDATED, updateThresholdPreview);
    }

    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, (type) => {
            activePromptObservation = { identity: getChatIdentity(), type: String(type || 'normal') };
        });
    }
    if (event_types.GENERATE_AFTER_COMBINE_PROMPTS) {
        eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, eventData => {
            observeFinalPrompt(eventData?.prompt, Boolean(eventData?.dryRun));
        });
    }
    if (event_types.CHAT_COMPLETION_PROMPT_READY) {
        eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, eventData => {
            observeFinalPrompt(eventData?.chat, Boolean(eventData?.dryRun));
        });
    }
    for (const eventName of ['GENERATION_ENDED', 'GENERATION_STOPPED']) {
        const event = event_types[eventName];
        if (event) eventSource.on(event, () => { activePromptObservation = null; });
    }

    // Re-apply marker/history classes as messages are rendered or chat DOM changes.
    for (const eventName of ['CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED']) {
        const event = event_types[eventName];
        if (event) eventSource.on(event, () => setTimeout(decorateMessages, 0));
    }

    const effective = getEffectiveSettings();
    console.info(`${LOG_PREFIX} Ready. Context: ${effective.contextWindowTokens.toLocaleString()} tokens; auto trigger: ${effective.thresholdTokens.toLocaleString()} (${effective.triggerPercent}%).`);
}

jQuery(async () => {
    try {
        await initialize();
    } catch (error) {
        console.error(`${LOG_PREFIX} Initialization failed`, error);
        toastr.error(String(error?.message || error), 'CC Compact extension failed to load');
    }
});

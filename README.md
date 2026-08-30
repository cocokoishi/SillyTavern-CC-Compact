# CC Compact for SillyTavern

> **v1.4.1:** makes `/goal` a serial continuous loop that runs until **Stop Goal** or `/goal stop`, while keeping the persistent reasoning toggle and non-modal status UI.


A Claude Code-style context compaction extension for SillyTavern, adapted for long SillyTavern sessions.

**Default behavior:** Compact follows SillyTavern's current context size and runs when the projected next prompt reaches **90%**. It folds old chat history into dense story memory, keeps a recent tail verbatim, removes folded source messages from the model prompt without deleting them from the chat, and then lets the original generation continue.

After compaction the chat timeline shows one of these markers:

> Context automatically compacted

> Context manually compacted

The state is **per chat/session**. Switching chats restores that chat's own compacted context and settings.

## Features

- `/compact` — manually compact the current chat.
- `/compact status` — show current threshold, hidden-message count, summary size, and last compaction.
- `/compact reset` — clear the compacted summary and put messages hidden by this extension back into the model context.
- `/goal` — open the Goal interface with random prompt, native impersonate, and lightweight CC impersonate modes.
- Automatic compaction before generation at **90% of the selected context window**.
- Built-in context presets: `32766`, `65536`, `131072`, `262144`, `400000`, and `500000`, plus automatic and custom modes.
- Global settings plus optional **per-chat overrides**.
- Editable compaction prompt.
- Editable current compacted context.
- Persistent per-chat summary/state using SillyTavern chat metadata.
- Old source messages are **not deleted**. They remain visible in chat history and are only excluded from future prompts.
- Chunked summarization for very large histories.
- Carries the previous compacted context forward on later compactions.
- Safety margin and anti-loop guard to avoid repeatedly compacting immediately after a verbose summary.
- Uses the currently selected SillyTavern model/API; no Extras module and no server plugin are required.

## Installation

Requires **SillyTavern 1.18.0 or newer**.

1. Open **Extensions** in SillyTavern.
2. Choose **Install Extension**.
3. Paste:

   ```text
   https://github.com/cocokoishi/SillyTavern-CC-Compact
   ```

4. Install it. Reload SillyTavern if the extension panel does not appear immediately.
5. Open **Extensions → Compact** to configure it.

## How it works

Compact deliberately does more than a normal "summary memory" extension.

1. SillyTavern calls Compact's generation interceptor before building a real generation request.
2. Compact counts active chat and story memory, adds known character/lore injections, and uses the numeric overhead observed from finalized prompts on earlier turns. This lets it account for prompt additions without ever storing their text.
3. At the configured percentage, Compact selects old visible messages while preserving an adaptively sized recent tail.
4. The selected model summarizes only the old chat transcript and previous story memory. Very large histories are processed in chunks.
5. Only after a valid summary is returned, those source messages are marked hidden-from-prompt using SillyTavern's native hidden-message mechanism (`is_system=true`). They remain in the chat file and stay readable in the UI.
6. The story memory is stored in the current chat's metadata and inserted at the boundary before the retained recent chat.
7. A hidden system event is added to the visible timeline, then the triggering generation continues using the compacted context.

This means the old messages no longer consume model context after a successful compaction. The summary is not merely appended on top of the still-full history.

## Settings

The normal interface contains one setting: **Context window**. Choose **Follow SillyTavern**, one of the six built-in presets, or a custom size. Automatic compaction begins at 90% by default and is capped by the active backend's real prompt limit.

Everything else is folded under **Advanced settings and current chat**. Advanced controls include trigger percentage, recent-tail budget, summary target, chunk input limit, anti-loop guard, story-memory prompt, injection template, and per-chat overrides. Recent-tail and summary targets are automatically capped on smaller contexts so compaction always frees useful space.

The default prompt preserves only fictional characters, relationships, locations, events, lore, inventory, current scene state, and unresolved plot threads. It explicitly discards Chat Completion Presets, jailbreaks, system/developer controls, API directives, and other out-of-story instructions.

### Per chat

Enable **Use per-chat advanced settings** to override context size, trigger percentage, recent-tail size, summary target, max input, and compaction prompt for only the current chat. These values travel with that chat's metadata.

The **Current compacted context** box is also per-chat and editable. Editing it immediately changes the compacted context injected on the next generation.

All of these controls are available from **Extensions → CC Compact**. The panel also includes **Compact now**, **Reset chat compaction**, prompt/default reset buttons, and a per-chat status line showing hidden-message count, summary token estimate, trigger type, and last compact time.

## Manual compaction

Typing:

```text
/compact
```

compacts immediately and ignores the automatic percentage trigger. If the conversation is shorter than the configured recent-tail budget, manual mode still folds everything except the newest two visible messages so the command is useful on shorter chats too.

## Goal

Type `/goal` to open a three-mode interface. Its selected mode, random prompt library, native impersonate instruction, and auto-send preference are stored in SillyTavern extension settings and survive reloads.

- **Random prompt** picks one non-empty line from the saved prompt library. It avoids immediately repeating the previous prompt when alternatives exist.
- **SillyTavern impersonate** calls the native `Generate('impersonate')` path, so it uses the active character, lore, prompt formatting, and normal SillyTavern impersonation behavior.
- **CC impersonate** is deliberately lightweight. It includes at most four recent messages within an 800-character input budget and makes one `generateRaw` request. Reasoning and response length use the active SillyTavern/model settings; the returned response content is used directly without truncation.

The independent **Disable reasoning for impersonate requests** option is persisted with Goal settings. When enabled, Compact temporarily requests `reasoning_effort=none` and disables returned thoughts/reasoning for native and CC impersonate calls, then restores the original SillyTavern settings after the request. Unsupported backends may ignore this option.

Press **Run Goal** to start a serial loop. Each round creates the next user message, sends it when **Send immediately** is enabled, waits for the character reply to finish, and only then starts the next round. It continues until **Stop Goal** is clicked or `/goal stop` is entered. If **Send immediately** is disabled, each round replaces the draft in the input box; use **Stop Goal** to end the loop and edit the final draft.

Goal uses a non-modal floating panel. Compaction and Goal requests show only a compact status notice, so the rest of SillyTavern stays operable while work is running.

## Persistence and reset

Compact stores its state under a dedicated key in SillyTavern's per-chat metadata. It also tags every source message that it hides.

`/compact reset` only unhides messages that **Compact itself** hid. Messages that were already hidden by the user or by another extension are not touched.

Compaction markers are retained as audit/history events; they are system messages and therefore do not consume normal chat context.

## Cost and model behavior

Compaction is a real LLM generation using your currently selected SillyTavern backend. It therefore consumes local compute and/or API tokens according to that backend. Very large conversations may require multiple summary calls if the active model cannot accept all folded history in one request.

Token counts can differ slightly between SillyTavern's tokenizer estimate and a provider's billing tokenizer. Compact observes finalized prompt token totals in memory to estimate non-chat overhead on the following turn; the prompt text itself is not persisted or sent to the compaction model.

## Why the anti-loop guard exists

A poor or overly long summary can leave the context close to the trigger threshold. Compact records the last automatic compaction and requires new visible messages before another automatic pass. Failed automatic attempts are also temporarily snoozed. This prevents a single generation from getting stuck in a repeated compact → still too large → compact cycle.

## Files

```text
Compact/
├── index.js
├── settings.html
├── style.css
├── manifest.json
├── README.md
└── LICENSE
```

## License

MIT.

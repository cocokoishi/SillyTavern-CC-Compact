# CC Compact for SillyTavern

A Claude Code-style context compaction extension for SillyTavern, adapted for long SillyTavern sessions.

**Default behavior:** when the prompt for the next generation reaches **250,000 tokens**, Compact folds old chat history into a dense persistent summary, keeps a recent tail verbatim, removes the folded source messages from the model prompt without deleting them from the chat, and then lets the original generation continue.

After compaction the chat timeline shows one of these markers:

> Context automatically compacted

> Context manually compacted

The state is **per chat/session**. Switching chats restores that chat's own compacted context and settings.

## Features

- `/compact` — manually compact the current chat.
- `/compact status` — show current threshold, hidden-message count, summary size, and last compaction.
- `/compact reset` — clear the compacted summary and put messages hidden by this extension back into the model context.
- Automatic compaction before generation, default threshold: **250k tokens**.
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
2. If the upcoming context is at/above the configured threshold, Compact selects old visible messages while preserving a recent tail (24k tokens by default).
3. The selected model summarizes those messages. Very large histories are processed in chunks, with each chunk folded into the previous compacted state.
4. Only after a valid summary is returned, those source messages are marked hidden-from-prompt using SillyTavern's native hidden-message mechanism (`is_system=true`). They remain in the chat file and stay readable in the UI.
5. The compacted summary is stored in the current chat's metadata and injected back into the prompt as a system context block.
6. A hidden system event is added to the visible timeline: `Context automatically compacted` or `Context manually compacted`.
7. The generation that triggered automatic compaction then proceeds using the compacted context.

This means the old messages no longer consume model context after a successful compaction. The summary is not merely appended on top of the still-full history.

## Settings

### Global

| Setting | Default | Meaning |
|---|---:|---|
| Automatic compaction | On | Run compaction before a normal generation when the threshold is reached. |
| Auto threshold | `250000` tokens | Upcoming prompt size that triggers automatic compaction. |
| Keep recent | `24000` tokens | Approximate amount of newest visible chat kept verbatim. |
| Summary target | `8192` tokens | Maximum requested output length for each compaction pass. |
| Max input / summary request | `160000` tokens | Upper bound for transcript material sent in one chunk; Compact also clamps this to the active model context. |
| Min new messages before re-compact | `3` | Anti-loop guard: after an automatic compact, require this many new visible messages before another automatic compact. |
| Compaction prompt | Built in | Instructions used to build the dense continuation state. Fully editable. |
| Summary injection template | Built in | Advanced template used to inject the persistent compacted state. Must contain `{{summary}}`. |
| Show marker | On | Add compact event markers to the chat timeline. |

### Per chat

Enable **Use per-chat settings** to override threshold, recent-tail size, summary target, max input, and compaction prompt for only the current chat. These values travel with that chat's metadata.

The **Current compacted context** box is also per-chat and editable. Editing it immediately changes the compacted context injected on the next generation.

All of these controls are available from **Extensions → CC Compact**. The panel also includes **Compact now**, **Reset chat compaction**, prompt/default reset buttons, and a per-chat status line showing hidden-message count, summary token estimate, trigger type, and last compact time.

## Manual compaction

Typing:

```text
/compact
```

compacts immediately and ignores the automatic 250k trigger. If the conversation is shorter than the configured `Keep recent` budget, manual mode still folds everything except the newest two visible messages so the command is useful on shorter chats too.

## Persistence and reset

Compact stores its state under a dedicated key in SillyTavern's per-chat metadata. It also tags every source message that it hides.

`/compact reset` only unhides messages that **Compact itself** hid. Messages that were already hidden by the user or by another extension are not touched.

Compaction markers are retained as audit/history events; they are system messages and therefore do not consume normal chat context.

## Cost and model behavior

Compaction is a real LLM generation using your currently selected SillyTavern backend. It therefore consumes local compute and/or API tokens according to that backend. A 250k-token conversation may require multiple summary calls if your selected model cannot accept that much input in one request.

Token counts can differ slightly between SillyTavern's tokenizer estimate and a provider's billing tokenizer. The threshold uses the context-size value SillyTavern calculates for the upcoming generation.

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

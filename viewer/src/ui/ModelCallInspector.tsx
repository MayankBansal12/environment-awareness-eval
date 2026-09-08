/**
 * The model-call inspector: for one decision, what the model was actually sent and what it
 * sent back.
 *
 * Every other pane in the cockpit reads `trace.jsonl`, which records what the *harness*
 * did — the status block it injected, the tool actions it observed, how it graded the run.
 * None of that is the model's context. This panel reads `context.jsonl`, the sidecar that
 * holds the literal message array handed to the runtime at each decision boundary and the
 * assistant text, reasoning, and tool calls that came back.
 *
 * Three rules shape what it will and will not say.
 *
 * **It is captured model context, not the provider wire request.** The harness captures at
 * the `context` seam, after its own annotation and before Pi serializes anything. Sampling
 * parameters and the provider's own encoding are below that seam and are not here, so the
 * panel labels itself accordingly rather than implying it holds the request.
 *
 * **Missing data is labelled, never faked.** Fifty-six runs in the corpus predate the
 * capture entirely, and a run that lost its provider mid-turn has an input with no output.
 * Where the sidecar cannot answer, the panel falls back to what the trace *does* record —
 * clearly marked as a partial reconstruction from trace previews — and the fidelity
 * limitations are listed in full under their own tab.
 *
 * **No timing is invented.** The harness records a wall-clock stamp per call and nothing
 * finer. There is no token-by-token stream in the artifact, so nothing here animates or
 * paces anything; a reader who wants elapsed time gets the recorded stamps and no more.
 */

import { forwardRef, useState } from 'react';
import {
  callAt,
  fidelityLabel,
  NO_CONTEXT,
  type BlobRef,
  type CapturedCall,
  type ContextBundle,
  type InternedBlock,
  type InternedMessage,
} from '../derive/context.js';
import type { RunBundle } from '../derive/model.js';
import { describeTruncation, truncationOfAction } from '../derive/truncation.js';

type Tab = 'call' | 'setup' | 'capture';

interface Props {
  run: RunBundle;
  /** The cockpit cursor. The inspector never holds its own — see `Cockpit`. */
  decisionIndex: number;
  /**
   * The shared content-addressed body table. Defaulted so the component can be rendered
   * from a test or a story with no corpus behind it; a missing body renders as an explicit
   * note rather than as empty text.
   */
  blobs?: Record<string, string>;
}

type ReadBlob = (ref: BlobRef | null) => string;

/**
 * One captured body, with the harness's own markup left where it actually sat.
 *
 * The `<environment_status>` and `<environment_event>` blocks are the independent variable
 * of the whole experiment, and *where* in the message they landed is part of the result —
 * so they are highlighted in place rather than lifted out into a summary line.
 */
function Body({ text }: { text: string }): JSX.Element {
  const parts = text.split(
    /(<environment_(?:status|event)>[\s\S]*?<\/environment_(?:status|event)>)/g,
  );
  return (
    <pre className="call-body">
      {parts.map((part, index) =>
        part.startsWith('<environment_') ? <mark key={index}>{part}</mark> : part,
      )}
    </pre>
  );
}

/**
 * What the capture did to this body, if anything.
 *
 * Truncation, secret redaction and omission are three different things and are never
 * collapsed into one word: a truncated body is one the artifact holds a prefix of, a
 * redacted one had a credential rewritten, and an omitted one was described rather than
 * carried at all.
 */
function Flags({
  truncated,
  redacted,
  omitted,
}: {
  truncated?: boolean | undefined;
  redacted?: boolean | undefined;
  omitted?: boolean | undefined;
}): JSX.Element | null {
  if (truncated !== true && redacted !== true && omitted !== true) return null;
  return (
    <span className="capture-flags">
      {truncated === true && ' · truncated'}
      {redacted === true && ' · secret redacted'}
      {omitted === true && ' · content omitted'}
    </span>
  );
}

function Block({ block, read }: { block: InternedBlock; read: ReadBlob }): JSX.Element {
  switch (block.kind) {
    case 'text':
      return (
        <div>
          <Flags truncated={block.truncated} redacted={block.redacted} />
          <Body text={read(block.ref)} />
        </div>
      );

    case 'thinking':
      return (
        <details className="call-block">
          <summary>
            Provider reasoning
            {block.providerRedacted && ' · withheld by the provider'}
            <Flags truncated={block.truncated} redacted={block.redacted} />
          </summary>
          <Body text={read(block.ref) || '(no plaintext returned)'} />
        </details>
      );

    case 'toolCall':
      return (
        <details className="call-block">
          <summary>
            Tool call · {block.name} · {block.id}
            <Flags
              truncated={block.truncatedArguments.length > 0}
              redacted={block.redacted}
              omitted={block.depthCapped}
            />
          </summary>
          <Body text={read(block.argumentsRef)} />
        </details>
      );

    case 'image':
      return (
        <p className="capture-note">
          Image payload omitted · {block.mimeType} · {block.dataChars} base64 characters
        </p>
      );

    case 'unsupported':
      return (
        <p className="capture-note">
          Unsupported block · {block.blockType}: {block.note}
        </p>
      );
  }
}

function Message({
  message,
  index,
  read,
  updateText = '',
}: {
  message: InternedMessage;
  index: number;
  read: ReadBlob;
  updateText?: string;
}): JSX.Element {
  // Opened by default when the harness put something in this message, because that is the
  // message a reader scrolling a 60-message context is looking for.
  const text = read(message.textRef);
  const containsUpdate =
    updateText.length > 0 && text.replaceAll('\\n', '\n').includes(updateText);
  const carriesEnvironment = text.includes('<environment_') || containsUpdate;
  return (
    <details
      className={`call-message${carriesEnvironment ? ' has-environment' : ''}`}
      open={carriesEnvironment}
    >
      <summary>
        <span>
          #{index + 1} · {message.role}
          {message.toolName !== null && ` · ${message.toolName}`}
        </span>
        {carriesEnvironment && (
          <span className="environment-label">
            {containsUpdate ? 'update content here' : 'environment here'}
          </span>
        )}
        <Flags
          truncated={message.truncated}
          redacted={message.redacted}
          omitted={message.omitted}
        />
      </summary>

      {message.toolCallId !== null && (
        <div className="capture-note">
          tool call {message.toolCallId}
          {message.isError === true && ' · error'}
        </div>
      )}

      {message.blocks === null ? (
        <>
          {/* A v1 record. Absence of structure means "not captured", never "no tool
              calls here", so it is stated rather than rendered as an empty message. */}
          <p className="capture-note">
            Text-only historical capture · non-text blocks were not recorded, so this
            message may have carried tool calls or reasoning that cannot be recovered.
          </p>
          <Body text={read(message.textRef)} />
        </>
      ) : (
        message.blocks.map((block, blockIndex) => (
          <Block key={blockIndex} block={block} read={read} />
        ))
      )}
    </details>
  );
}

/** The input half: the exact message array the runtime received for this call. */
function InputColumn({
  run,
  call,
  decisionIndex,
  read,
}: {
  run: RunBundle;
  call: CapturedCall | undefined;
  decisionIndex: number;
  read: ReadBlob;
}): JSX.Element {
  const boundary = run.trace.find(
    (event) => event.type === 'decision_boundary' && event.decisionIndex === decisionIndex,
  );
  const scenarioMessage = run.trace.find(
    (e) => e.type === 'slack_message' && e.origin === 'scenario',
  );
  const updateText =
    scenarioMessage?.type === 'slack_message' ? scenarioMessage.text.trim() : '';

  return (
    <div className="call-column" aria-label="Input to selected decision">
      <h4>Input · what the model was sent at D{decisionIndex}</h4>
      {call?.input != null ? (
        <>
          <p className="capture-note">
            {call.input.messageCount} messages, in captured order. Highlighted blocks are
            the environment surface at the position it actually occupied.
          </p>
          <button
            onClick={(event) =>
              event.currentTarget
                .closest('.call-column')
                ?.querySelector('.has-environment')
                ?.scrollIntoView({ block: 'nearest' })
            }
          >
            Jump to environment
          </button>
          {call.input.messages.map((message, index) => (
            <Message
              key={index}
              message={message}
              index={index}
              read={read}
              updateText={updateText}
            />
          ))}
        </>
      ) : (
        <>
          <p className="capture-note">
            Partial reconstruction · the input messages for this decision were not captured.
            Only the environment blocks the trace recorded are available; the surrounding
            conversation is not recoverable.
          </p>
          {boundary?.type === 'decision_boundary' && (
            <>
              <Body text={boundary.statusBlock ?? '(no status block recorded)'} />
              {boundary.eventBlocks.map((event, index) => (
                <Body key={index} text={event.block} />
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One tool call from this decision, paired with the result the model actually saw.
 *
 * The result is not guessed: a tool result enters the conversation as a `toolResult`
 * message in a *later* call's input, so it is looked up by `toolCallId` in the next
 * captured input that contains it. That message may carry annotation added at that later
 * boundary, which is stated rather than stripped. With no capture to pair against, the
 * trace's own bounded preview is shown and labelled as a preview.
 */
function ToolCallRow({
  bundle,
  run,
  decisionIndex,
  tool,
  read,
}: {
  bundle: ContextBundle;
  run: RunBundle;
  decisionIndex: number;
  tool: {
    id: string;
    name: string;
    argumentsRef: BlobRef;
    truncatedArguments: string[];
    redacted: boolean;
    depthCapped: boolean;
  };
  read: ReadBlob;
}): JSX.Element {
  const carrier = bundle.calls.find(
    (next) =>
      next.decisionIndex > decisionIndex &&
      next.input?.messages.some((message) => message.toolCallId === tool.id) === true,
  );
  const result = carrier?.input?.messages.find((message) => message.toolCallId === tool.id);
  const action = run.trace.find(
    (event) =>
      event.type === 'tool_action' &&
      event.decisionIndex === decisionIndex &&
      event.toolCallId === tool.id,
  );

  return (
    <details className="call-tool" open>
      <summary>
        {tool.name} · {tool.id}
        <Flags
          truncated={tool.truncatedArguments.length > 0}
          redacted={tool.redacted}
          omitted={tool.depthCapped}
        />
      </summary>

      <h5>Arguments as the model emitted them</h5>
      <Body text={read(tool.argumentsRef)} />

      <h5>Result the model saw</h5>
      {result !== undefined && carrier !== undefined ? (
        <>
          <p className="capture-note">
            As it appeared in the captured input of D{carrier.decisionIndex}, including any
            annotation the harness applied at that later boundary.
          </p>
          <Message message={result} index={0} read={read} />
        </>
      ) : action?.type === 'tool_action' ? (
        <>
          <p className="capture-note">
            Trace preview only · {describeTruncation(truncationOfAction(action))}
          </p>
          <Body text={action.outputPreview} />
        </>
      ) : (
        <p className="capture-note">No tool result was captured for this call.</p>
      )}
    </details>
  );
}

/** The output half: the assistant message this call produced. */
function OutputColumn({
  bundle,
  run,
  call,
  decisionIndex,
  read,
}: {
  bundle: ContextBundle;
  run: RunBundle;
  call: CapturedCall | undefined;
  decisionIndex: number;
  read: ReadBlob;
}): JSX.Element {
  const output = call?.output ?? null;
  const turn = run.trace.find(
    (event) => event.type === 'assistant_turn' && event.decisionIndex === decisionIndex,
  );
  const actions = run.trace.filter(
    (event) => event.type === 'tool_action' && event.decisionIndex === decisionIndex,
  );

  if (output === null) {
    return (
      <div className="call-column" aria-label="Output of selected decision">
        <h4>Output · what the model sent back</h4>
        <p className="capture-note">
          {call?.input != null
            ? 'The input was captured but the matching output is missing — expected when a ' +
              'run was aborted, timed out, or lost its provider on this turn.'
            : 'Partial reconstruction · assistant text and tool previews below come from ' +
              'the trace. Full arguments and untruncated outputs are not recoverable.'}
        </p>
        {turn?.type === 'assistant_turn' && (
          <Body text={turn.text || '(no assistant text recorded)'} />
        )}
        {actions.map(
          (action) =>
            action.type === 'tool_action' && (
              <details className="call-tool" key={action.seq}>
                <summary>{action.toolName} · trace preview</summary>
                <Body text={JSON.stringify(action.inputSummary, null, 2)} />
                <Body text={action.outputPreview} />
                <p className="capture-note">
                  {describeTruncation(truncationOfAction(action))}
                </p>
              </details>
            ),
        )}
      </div>
    );
  }

  return (
    <div className="call-column" aria-label="Output of selected decision">
      <h4>Output · what the model sent back</h4>
      <p className="capture-note">
        stop reason: {output.stopReason} · captured {output.wallClockIso}
        <Flags
          truncated={output.textCapture?.truncated}
          redacted={output.textCapture?.redacted}
        />
      </p>

      {output.providerErrorMessage !== null && (
        <>
          <p className="capture-note">The provider returned an error on this turn:</p>
          <Body text={output.providerErrorMessage} />
        </>
      )}

      <Body text={read(output.textRef) || '(no assistant text)'} />

      <details className="call-block">
        <summary>
          Provider reasoning
          {output.reasoningRedacted && ' · withheld by the provider'}
          <Flags
            truncated={output.reasoningCapture?.truncated}
            redacted={output.reasoningCapture?.redacted}
          />
        </summary>
        {/* Whether reasoning comes back at all is the provider's decision. An absent
            block is never evidence that the model did not reason, and must not be read
            as evidence about awareness either way. */}
        <Body
          text={
            output.reasoningRef === null
              ? 'No reasoning text was returned or captured. This is not evidence that the ' +
                'model did no reasoning — many providers withhold the text entirely.'
              : read(output.reasoningRef) || '(no plaintext returned)'
          }
        />
      </details>

      {output.toolCalls.map((tool) => (
        <ToolCallRow
          key={tool.id}
          bundle={bundle}
          run={run}
          decisionIndex={decisionIndex}
          tool={tool}
          read={read}
        />
      ))}

      <details className="call-block">
        <summary>Reported token usage</summary>
        <Body
          text={
            output.usage === null
              ? 'The provider reported no usage breakdown for this call.'
              : JSON.stringify(output.usage, null, 2)
          }
        />
      </details>
    </div>
  );
}

/** The run-level constants: the prompt, the tool surface and the pinned settings. */
function SetupTab({
  bundle,
  read,
}: {
  bundle: ContextBundle;
  read: ReadBlob;
}): JSX.Element {
  const header = bundle.header;
  if (header === null) {
    return (
      <div className="inspector-scroll">
        <p className="capture-note">
          No capture header is available for this run, so the effective runtime prompt, the
          tool schemas and the pinned settings cannot be recovered. Runs captured before the
          header was written at session start have this gap.
        </p>
      </div>
    );
  }

  return (
    <div className="inspector-scroll">
      <p className="capture-note">
        {header.provider}/{header.model} · thinking {header.thinkingLevel} · prompt source:{' '}
        {header.systemPromptSource ?? 'unspecified'}
        <Flags redacted={header.redacted} />
      </p>

      <h4>Captured system prompt</h4>
      {/* `runtime_session` is read off the live session, so it includes the lines Pi
          appends below the configured prompt. `harness_configured` means the getter was
          unavailable and this is the requested text, not the effective one. */}
      <Body text={read(header.systemPromptRef)} />

      <details className="call-block">
        <summary>Harness-configured prompt and opening user message</summary>
        <Body text={read(header.harnessSystemPromptRef)} />
        <Body text={read(header.initialUserPromptRef)} />
      </details>

      <details className="call-block">
        <summary>Pinned run settings</summary>
        <Body text={JSON.stringify(header.settings, null, 2)} />
      </details>

      <h4>{header.toolDefinitions.length} tool definitions advertised to the model</h4>
      {header.toolDefinitions.map((tool) => (
        <details className="call-tool" key={tool.name}>
          <summary>{tool.name}</summary>
          <Body text={tool.description} />
          <Body text={read(tool.parametersRef)} />
        </details>
      ))}
    </div>
  );
}

/** Completeness of the capture itself, kept firmly apart from the behavioural grade. */
function CaptureTab({ bundle }: { bundle: ContextBundle }): JSX.Element {
  return (
    <div className="inspector-scroll">
      <p className="capture-note">
        Capture completeness describes the diagnostic artifact, not the agent. Nothing on
        this tab is an input to the run's grade.
      </p>
      {bundle.fidelity.limitations.length > 0 ? (
        <ul>
          {bundle.fidelity.limitations.map((limitation, index) => (
            <li key={index}>{limitation}</li>
          ))}
        </ul>
      ) : (
        <p>Every decision the trace records has a captured call, with no fidelity gaps.</p>
      )}
      {bundle.audit !== null && (
        <details className="call-block">
          <summary>The harness's own capture audit</summary>
          <Body text={JSON.stringify(bundle.audit, null, 2)} />
        </details>
      )}
    </div>
  );
}

/**
 * Forwards a ref to its own root so the scrubber can scroll the reader here without
 * reaching into the document. The inspector still holds no cursor of its own.
 */
export const ModelCallInspector = forwardRef<HTMLElement, Props>(
  function ModelCallInspector({ run, decisionIndex, blobs = {} }: Props, ref): JSX.Element {
    const [tab, setTab] = useState<Tab>('call');
    const bundle = run.context ?? NO_CONTEXT;
    const call = callAt(bundle, decisionIndex);

    const read: ReadBlob = (ref) => {
      if (ref === null) return '(not captured)';
      return blobs[ref] ?? '[captured body missing from this viewer build]';
    };

    return (
      <section className="model-inspector" aria-label="Model call inspector" ref={ref}>
        <div className="inspector-heading">
          <h3>Model call · D{decisionIndex}</h3>
          <span className={`capture-badge ${bundle.fidelity.level}`}>
            {fidelityLabel(bundle.fidelity)}
          </span>
          <span className="capture-note">
            Captured model context · not the provider wire request
          </span>
        </div>

        <div className="tabs" aria-label="Inspector views">
          {(
            [
              ['call', 'Input & output'],
              ['setup', 'System & tools'],
              ['capture', 'Capture details'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              className={tab === value ? 'active' : ''}
              aria-pressed={tab === value}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'call' && (
          // Keyed on the run and decision so switching either resets the expanded messages
          // rather than carrying one decision's open state onto another's.
          <div className="call-columns" key={`${run.runId}:${decisionIndex}`}>
            <InputColumn run={run} call={call} decisionIndex={decisionIndex} read={read} />
            <OutputColumn
              bundle={bundle}
              run={run}
              call={call}
              decisionIndex={decisionIndex}
              read={read}
            />
          </div>
        )}

        {tab === 'setup' && <SetupTab bundle={bundle} read={read} />}
        {tab === 'capture' && <CaptureTab bundle={bundle} />}
      </section>
    );
  },
);

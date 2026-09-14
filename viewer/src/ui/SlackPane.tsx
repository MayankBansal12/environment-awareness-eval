/**
 * The Linear & Slack workspace, as a channel.
 *
 * Every message is stamped with what the agent knew about it *at the cursor*, because the
 * whole point of the run is the distance between a message existing and the agent acting
 * on it. A message in the channel that the agent has not read is drawn dim and struck with
 * its state in words; the environment event is drawn with a rail so it is findable at a
 * glance among the ordinary traffic.
 *
 * Unread counts come from the v4 `input` event rather than being
 * counted here, so the footer can never disagree with what was actually in the model's
 * status block.
 */

import type { Event } from '../../../src/schema.js';
import type { RunBundle } from '../derive/model.js';
import {
  describeVisibility,
  visibilityAt,
  type SlackMessageView,
  type SlackVisibility,
} from '../derive/slack.js';

type Boundary = Extract<Event, { type: 'input' }>;

interface Props {
  run: RunBundle;
  messages: readonly SlackMessageView[];
  cursor: number;
  onJumpToDecision: (decisionIndex: number) => void;
}

export function SlackPane({ run, messages, cursor, onJumpToDecision }: Props): JSX.Element {
  const boundary = run.trace.find(
    (event): event is Boundary => event.type === 'input' && event.decision === cursor,
  );

  const visible = messages.filter((message) => visibilityAt(message, cursor) !== 'unsent');
  const pending = messages.length - visible.length;

  return (
    <section className="pane slackpane">
      <h3>
        Linear & Slack workspace
        <span className="pane-note">as of D{cursor}</span>
      </h3>

      <div className="slack-channel">
        Inbox & channels
        <span>Environment messages</span>
      </div>
      <div className="pane-body">
        {visible.length === 0 && (
          <p className="empty-note">No messages in the channel at D{cursor}.</p>
        )}

        {visible.map((message) => (
          <SlackMessage
            key={message.messageId}
            message={message}
            visibility={visibilityAt(message, cursor)}
            onJumpToDecision={onJumpToDecision}
          />
        ))}

        {pending > 0 && (
          <p className="empty-note">
            {pending} later message{pending === 1 ? '' : 's'} not yet sent at D{cursor}.
          </p>
        )}
      </div>

      <div className="facts">
        {boundary === undefined ? (
          <div>No status block recorded at D{cursor}.</div>
        ) : (
          <>
            <div>
              Input status: Linear {boundary.counts.linear} unread · Slack{' '}
              {boundary.counts.slack} unread
            </div>
            <div>
              Retrieved text:{' '}
              {
                visible.filter((m) => ['read', 'exposed'].includes(visibilityAt(m, cursor)))
                  .length
              }{' '}
              messages retrieved through D{cursor}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function SlackMessage({
  message,
  visibility,
  onJumpToDecision,
}: {
  message: SlackMessageView;
  visibility: SlackVisibility;
  onJumpToDecision: (decisionIndex: number) => void;
}): JSX.Element {
  const perceivedAt =
    message.exposedAtDecision ?? message.readAtDecision ?? message.indicatedAtDecision;

  return (
    <article
      className={`slackmsg ${visibility}${message.isEnvironmentEvent ? ' is-event' : ''}`}
    >
      <header>
        <span className="avatar">{message.sender.slice(0, 1).toUpperCase()}</span>
        <span className="who">{message.sender}</span>
        <span className="role">
          {message.channel} · {message.senderRole.replace(/_/g, ' ')}
        </span>
        {message.mentionsAgent && <span className="mention-tag">@agent</span>}
        <span className="spacer" />
        <button
          className="linklike"
          title={`jump to the decision this message arrived at`}
          onClick={() => onJumpToDecision(Math.max(message.arrivedAtDecision, 0))}
        >
          D{message.arrivedAtDecision}
        </button>
      </header>

      <div className="slacktext">{message.text}</div>

      <footer>
        <span className={`vis ${visibility}`}>{describeVisibility(visibility)}</span>
        {message.cueOnly && visibility === 'read' && (
          <span className="mech">assignment cue · requirements in Linear</span>
        )}
        {perceivedAt !== null && visibility !== 'own' && (
          <button className="linklike" onClick={() => onJumpToDecision(perceivedAt)}>
            → D{perceivedAt}
          </button>
        )}
        {message.isEnvironmentEvent && message.deliveryMechanism !== null && (
          <span className="mech">{message.deliveryMechanism}</span>
        )}
      </footer>
    </article>
  );
}

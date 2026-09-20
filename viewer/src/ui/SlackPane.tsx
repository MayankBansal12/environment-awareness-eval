/** Incoming updates and agent replies, with visibility evaluated at the selected decision. */

import { useState } from 'react';
import { useRevealSelected } from './useRevealSelected.js';
import {
  describeVisibility,
  visibilityAt,
  type SlackMessageView,
  type SlackVisibility,
} from '../derive/slack.js';

interface Props {
  messages: readonly SlackMessageView[];
  cursor: number;
  selectedEventId: string | null;
  onJumpToDecision: (decisionIndex: number) => void;
}

export function SlackPane({
  messages,
  cursor,
  selectedEventId,
  onJumpToDecision,
}: Props): JSX.Element {
  const [showNoise, setShowNoise] = useState(false);
  const bodyRef = useRevealSelected(
    '[data-selected="true"]',
    `${selectedEventId}:${cursor}:${showNoise}`,
  );
  const visible = messages.filter((message) => visibilityAt(message, cursor) !== 'unsent');
  const shown = visible.filter((message) => showNoise || message.senderRole !== 'noise');
  const noiseCount = visible.filter((message) => message.senderRole === 'noise').length;

  return (
    <section className="pane slackpane">
      <h3>
        Updates
        <span className="spacer" />
        <label className="noise-toggle">
          <input
            type="checkbox"
            checked={showNoise}
            onChange={(e) => setShowNoise(e.target.checked)}
            aria-label="Show noise messages"
          />
          Noise{noiseCount > 0 ? ` (${noiseCount})` : ''}
        </label>
      </h3>

      <div className="pane-body" ref={bodyRef}>
        {shown.length === 0 && (
          <p className="empty-note">
            No {showNoise ? 'messages' : 'updates'} yet at D{cursor}.
          </p>
        )}

        {shown.map((message) => (
          <SlackMessage
            key={message.messageId}
            message={message}
            selected={message.eventId !== null && message.eventId === selectedEventId}
            visibility={visibilityAt(message, cursor)}
            onJumpToDecision={onJumpToDecision}
          />
        ))}
      </div>
    </section>
  );
}

function SlackMessage({
  message,
  selected,
  visibility,
  onJumpToDecision,
}: {
  message: SlackMessageView;
  selected: boolean;
  visibility: SlackVisibility;
  onJumpToDecision: (decisionIndex: number) => void;
}): JSX.Element {
  const perceivedAt =
    message.exposedAtDecision ?? message.readAtDecision ?? message.indicatedAtDecision;

  return (
    <article
      className={`slackmsg ${visibility}${message.isEnvironmentEvent ? ' is-event' : ''}`}
      data-selected={selected}
    >
      <header>
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
      </footer>
    </article>
  );
}

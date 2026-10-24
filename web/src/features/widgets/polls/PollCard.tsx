// polls/PollCard.tsx — a poll as a card (WIDGETS-UI.md §17.3; the desktop's PollCard.qml): "POLL" + the state, the
// question, one row per answer — a radio (a single choice) or a check (several) that votes on click while the poll is
// open, and, when the disclosure rule shows results (ended, or a disclosed poll once I voted), the answer's votes and a
// bar of its share (the winners of an ended poll in full accent with a star) — then the status line and, for the
// creator or a moderator, "End poll" (a confirm). An opaque card (`widget.polls.card.*`), so it reads the same in my
// bubble, in others' and in a preview. Motion: the bars ease to a new share (`barEase`, long 200 ms, only while animate).
import { useState } from "react";
import { ConfirmDialog, Icon, cx, useAnimate } from "@/ui";
import { nextChoice, sharePm, showResults, stateLine, statusLine, votesText, type Poll, type Tally } from "@/widgets/polls";
import s from "./PollCard.module.css";

export interface PollCardProps {
  poll: Poll;
  t: Tally;
  /** open for votes from here (not a preview, not my unsent poll) */
  canVote: boolean;
  canEnd: boolean;
  onVote?: (answers: string[]) => void;
  onEnd?: () => void;
  mobile?: boolean;
  /** the card's width limit (the chat bubble's inner width) */
  maxWidth?: number;
}

export function PollCard({ poll, t, canVote, canEnd, onVote, onEnd, mobile, maxWidth }: PollCardProps) {
  const animate = useAnimate();
  const [confirm, setConfirm] = useState(false);
  const show = showResults(poll, t);
  const open = !t.ended;
  const multi = poll.max > 1;
  const state = stateLine(poll, t);
  return (
    <div className={cx(s.card, mobile && s.mobile)} style={maxWidth ? { maxWidth } : undefined} role="group" aria-label={`Poll: ${poll.question}`} data-poll-ended={t.ended ? "" : undefined}>
      <div className={s.head}>
        <Icon name="view-statistics-symbolic" size={14} color="var(--th-widget-polls-meta-fg)" staticOnly />
        <span className={s.kind}>POLL</span>
        {state && <span className={s.state}>· {state}</span>}
      </div>
      <div className={s.question}>{poll.question}</div>
      <div className={s.answers} role={multi ? "group" : "radiogroup"} aria-label="Answers">
        {poll.answers.map((a, i) => {
          const n = t.counts[i]?.n ?? 0;
          const mine = t.mine.includes(a.id);
          const winner = t.ended && t.winners.includes(a.id);
          const pm = show ? sharePm(n, t.votes) : 0;
          const clickable = canVote && open && !!onVote;
          const click = () => {
            if (!clickable) return;
            const next = nextChoice(poll, t.mine, a.id);
            if (next) onVote!(next);
          };
          return (
            <div
              key={a.id}
              className={cx(s.answer, clickable && s.clickable, mine && s.mine, winner && s.winner)}
              role={multi ? "checkbox" : "radio"}
              aria-checked={mine}
              aria-disabled={!clickable || undefined}
              tabIndex={clickable ? 0 : -1}
              onClick={click}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), click())}
              data-poll-answer={a.id}
            >
              <div className={s.line}>
                <span className={cx(s.mark, multi ? s.check : s.radio, mine && s.markOn)} aria-hidden="true">
                  {mine && multi && <Icon name="checkmark-symbolic" size={10} color="var(--th-widget-polls-option-checked-fg)" staticOnly />}
                </span>
                <span className={s.text}>{a.text}</span>
                {winner && <Icon name="starred-symbolic" size={12} color="var(--th-widget-polls-winner-fg)" staticOnly />}
                {show && <span className={cx(s.count, winner && s.countWinner)}>{votesText(n)}</span>}
              </div>
              {show && (
                <div className={s.track} aria-hidden="true">
                  <div className={cx(s.fill, winner && s.fillWinner, animate && s.ease)} style={{ width: `${pm / 10}%` }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className={s.foot}>
        <span className={s.status}>{statusLine(poll, t)}</span>
        {canEnd && open && onEnd && (
          <button type="button" className={s.end} onClick={() => setConfirm(true)}>
            End poll
          </button>
        )}
      </div>
      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(false)}
          dialogTitle="End this poll?"
          message="Everyone sees the final result, and no more votes are counted."
          confirmText="End poll"
          onConfirmed={() => {
            setConfirm(false);
            onEnd?.();
          }}
        />
      )}
    </div>
  );
}

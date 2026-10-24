// polls/NewPoll.tsx — the New poll dialog (WIDGETS-UI.md §17.6; the desktop's NewPollDialog.qml): the question, the
// answers (2 to start, "Add answer" up to 20, × removes one while more than 2 remain), "Hide results until the poll ends"
// (an undisclosed poll) and Create poll — the shared startContent decides (trimmed, empty answers dropped, the limits and
// their friendly errors) and the poll is sent to the room in Element's shape (store.createPoll; js-sdk's local echo shows
// it at once). One choice per person, like Element's polls.
import { useState } from "react";
import { Dialog, Icon, Switch, TextField, cx } from "@/ui";
import { ANSWER_MAX, ANSWERS_MAX, QUESTION_MAX } from "@/widgets/polls";
import { createPoll } from "./store";
import s from "./NewPoll.module.css";

export function NewPollDialog({ roomId, onClose, mobile }: { roomId: string; onClose: () => void; mobile?: boolean }) {
  const [question, setQuestion] = useState("");
  const [answers, setAnswers] = useState<string[]>(["", ""]);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState("");
  const create = () => {
    const err = createPoll(roomId, question, answers, hidden ? "undisclosed" : "disclosed");
    if (err) setError(err);
    else onClose();
  };
  const set = (i: number, v: string) => {
    setAnswers((a) => a.map((x, j) => (j === i ? v : x)));
    setError("");
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="New poll"
      width={mobile ? "100%" : 420}
      standardButtons={["cancel"]}
      buttons={[{ text: "Create poll", role: "accept", onClick: create }]}
      initialFocus="tw-newpoll-q"
      className={cx(mobile && s.sheet)}
    >
      <div className={s.form} onKeyDown={(e) => e.stopPropagation()}>
        <label className={s.label} htmlFor="tw-newpoll-q">
          Question
        </label>
        <TextField
          id="tw-newpoll-q"
          value={question}
          placeholder="What are we playing tonight?"
          maxLength={QUESTION_MAX}
          onChange={(e) => {
            setQuestion(e.target.value);
            setError("");
          }}
          data-newpoll-question=""
        />
        <div className={s.label}>Answers</div>
        <div className={s.answers}>
          {answers.map((a, i) => (
            <div key={i} className={s.answerRow}>
              <TextField
                className={s.answer}
                value={a}
                placeholder={`Answer ${i + 1}`}
                maxLength={ANSWER_MAX}
                aria-label={`Answer ${i + 1}`}
                onChange={(e) => set(i, e.target.value)}
                onAccepted={() => (i === answers.length - 1 && answers.length < ANSWERS_MAX ? setAnswers((x) => [...x, ""]) : undefined)}
                data-newpoll-answer={i}
              />
              {answers.length > 2 && (
                <button type="button" className={s.remove} aria-label={`Remove answer ${i + 1}`} onClick={() => setAnswers((x) => x.filter((_, j) => j !== i))}>
                  <Icon name="window-close-symbolic" size={12} color="currentColor" staticOnly />
                </button>
              )}
            </div>
          ))}
        </div>
        {answers.length < ANSWERS_MAX && (
          <button type="button" className={s.add} onClick={() => setAnswers((x) => [...x, ""])}>
            <Icon name="list-add-symbolic" size={12} color="currentColor" staticOnly />
            Add answer
          </button>
        )}
        <Switch text="Hide results until the poll ends" checked={hidden} onToggled={setHidden} />
        {error && (
          <div className={s.error} role="alert">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}

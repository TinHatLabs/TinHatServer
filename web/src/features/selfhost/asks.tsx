// asks.tsx — the calm first run's questions (selfhost/firstrun item 2; which one shows where: firstrun.ts askPlan).
//   <TourOfferCard/>    the footer slot (where the notifications / presence cards sat): "New here? Take a 1-minute
//                       tour." [No thanks] [Take the tour] — until answered or this device sends its first message
//   <NotifyAskBanner/>  r.roomBanners: after this device's first message, on the room page, the notifications question
//                       (push's own question and its [Turn on] / [Not now], PermissionCard.tsx)
//   <StatusAskBanner/>  the top of the Settings window: the online-status question (presence's own words and answer)
import { useState } from "react";
import { bus } from "@/core/bus";
import { useCryptoStatus, useSession } from "@/core/matrix";
import { setPref, usePref } from "@/core/prefs";
import { isGuestAccount } from "@/core/server";
import { Button, Icon, cx } from "@/ui";
import { PERMISSION_QUESTION, askNotificationPermission, snoozeNotifyAsk, useNotifyCardVisible } from "@/features/push/PermissionCard";
import { QUESTION as STATUS_QUESTION, useStatusQuestionVisible } from "@/features/presence/controls";
import { answerQuestion } from "@/features/presence/runtime";
import { useVerifyUi } from "@/features/settings/VerifyDeviceDialog";
import { TOUR_OFFER, TOUR_OFFER_NO, TOUR_OFFER_YES, askPlan } from "./firstrun";
import { useKeyStepOpen } from "./FirstKeyDialog";
import { SENT_FIRST_PREF } from "./watch";
import s from "./asks.module.css";

const NONE = { tourSeen: true, sentFirst: false, modalOpen: false, notifyAskable: false, statusAskable: false };

/** A modal of the first run is up (the verify dialog / the Security Key step, or the first device still setting up). */
function useFirstRunModal(): boolean {
  const verifyOpen = useVerifyUi((v) => v.open);
  const keyStep = useKeyStepOpen((k) => k.open);
  const firstPending = useCryptoStatus().firstDevicePending;
  return verifyOpen || keyStep || firstPending;
}

export function TourOfferCard({ mobile, island }: { mobile?: boolean; island?: boolean | "flat" }) {
  const tourSeen = usePref("tour_seen", "") === "1";
  const sentFirst = usePref(SENT_FIRST_PREF, false);
  const modalOpen = useFirstRunModal();
  const session = useSession();
  const ready = session.state === "ready";
  // a temporary guest account (docs/GUESTS.md) is here for one evening: no tour offer
  if (!ready || isGuestAccount(session.userId) || !askPlan({ ...NONE, tourSeen, sentFirst, modalOpen }).tourOffer) return null;
  return (
    <div
      className={cx(s.ask, s.footer)}
      data-mobile={mobile ? "" : undefined}
      data-placement={island === "flat" ? "flat" : island ? "island" : undefined}
      role="dialog"
      aria-label="Take a 1-minute tour?"
      data-tour-offer=""
    >
      <div className={s.head}>
        <Icon name="help-hint-symbolic" size={16} color="var(--th-account-ask-icon)" className={s.icon} />
        <div className={s.text}>{TOUR_OFFER}</div>
      </div>
      <div className={s.btns}>
        <Button className={s.btn} flat text={TOUR_OFFER_NO} onClick={() => setPref("tour_seen", "1")} />
        <Button
          className={s.btn}
          highlighted
          text={TOUR_OFFER_YES}
          onClick={() => {
            setPref("tour_seen", "1");
            bus.emit("openTour", {});
          }}
        />
      </div>
    </div>
  );
}

export function NotifyAskBanner(_: { roomId: string }) {
  const askable = useNotifyCardVisible();
  const sentFirst = usePref(SENT_FIRST_PREF, false);
  const modalOpen = useFirstRunModal();
  const [busy, setBusy] = useState(false);
  if (!askPlan({ ...NONE, sentFirst, modalOpen, notifyAskable: askable }).notifyBanner) return null;
  const turnOn = () => {
    const asked = askNotificationPermission(); // inside the click (iOS)
    if (!asked) return;
    setBusy(true);
    void asked.then(() => setBusy(false));
  };
  return (
    <div className={cx(s.ask, s.room)} role="region" aria-label={PERMISSION_QUESTION} data-notify-ask="">
      <div className={s.head}>
        <Icon name="notifications" size={16} color="var(--th-account-ask-icon)" className={s.icon} />
        <div className={s.text}>{PERMISSION_QUESTION}</div>
      </div>
      <div className={s.btns}>
        <Button className={s.btn} flat text="Not now" disabled={busy} onClick={snoozeNotifyAsk} />
        <Button className={s.btn} highlighted text="Turn on" disabled={busy} onClick={turnOn} />
      </div>
    </div>
  );
}

export function StatusAskBanner() {
  const askable = useStatusQuestionVisible();
  const [busy, setBusy] = useState(false);
  if (!askPlan({ ...NONE, statusAskable: askable }).statusBanner) return null;
  const answer = async (on: boolean) => {
    setBusy(true);
    await answerQuestion(on);
    setBusy(false);
  };
  return (
    <div className={cx(s.ask, s.settings)} role="region" aria-label="Share your status?" data-status-ask="">
      <div className={s.head}>
        <span className={s.dot} />
        <div className={s.text}>{STATUS_QUESTION}</div>
      </div>
      <div className={s.btns}>
        <Button className={s.btn} flat text="No thanks" disabled={busy} onClick={() => void answer(false)} />
        <Button className={s.btn} highlighted text="Turn on" disabled={busy} onClick={() => void answer(true)} />
      </div>
    </div>
  );
}

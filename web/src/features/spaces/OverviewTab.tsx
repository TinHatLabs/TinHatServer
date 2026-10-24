// OverviewTab.tsx — SSW Overview: photo (hover "Change photo", × to remove), Name / Topic with the
// Save changes / Discard row, "Who can join" radios (apply at once), the space link + Copy, stats.
// Drafts (SSW _syncOverview): a remote rename shows up unless the user is mid-edit.
import { useEffect, useRef, useState } from "react";
import { toast } from "@/core/bus";
import { Avatar, Button, GlowButton, HintLabel, Icon, RadioButton, ScrollArea, SectionLabel, Separator, TextArea, TextField, ToolButton, cx } from "@/ui";
import { spaceActions, useSpaceAdmin } from "./store";
import { copyText } from "./roomActions";
import s from "./SpaceSettings.module.css";

export function OverviewTab({ mobile, onLeave }: { mobile?: boolean; onLeave?: () => void }) {
  const summary = useSpaceAdmin((st) => st.summary);
  const busy = useSpaceAdmin((st) => st.busy);
  const spaceId = useSpaceAdmin((st) => st.spaceId);
  const canManage = !!summary?.canManageSpace;
  const serverName = summary?.name ?? "";
  const serverTopic = summary?.topic ?? "";

  const [name, setName] = useState(serverName);
  const [topic, setTopic] = useState(serverTopic);
  const seed = useRef({ name: serverName, topic: serverTopic });
  const fields = useRef({ name, topic });
  fields.current = { name, topic };

  // _syncOverview on summary change / space change
  useEffect(() => {
    const f = fields.current;
    const userDirty = f.name !== seed.current.name || f.topic !== seed.current.topic;
    if (!userDirty || (f.name === serverName && f.topic === serverTopic)) {
      setName(serverName);
      setTopic(serverTopic);
      seed.current = { name: serverName, topic: serverTopic };
    }
  }, [serverName, serverTopic, spaceId]);

  const dirty = name !== serverName || topic !== serverTopic;
  const save = () => {
    if (name !== serverName) spaceActions.applyName(name.trim());
    if (topic !== serverTopic) spaceActions.applyTopic(topic);
    seed.current = { name, topic };
  };
  const discard = () => {
    setName(serverName);
    setTopic(serverTopic);
    seed.current = { name: serverName, topic: serverTopic };
  };

  const fileRef = useRef<HTMLInputElement>(null);
  const [hover, setHover] = useState(false);
  const pick = () => canManage && fileRef.current?.click();
  const joinRule = summary?.joinRule ?? "invite";
  const link = summary?.link ?? "";

  const stats = summary
    ? [
        `${summary.memberCount} ${summary.memberCount === 1 ? "member" : "members"}`,
        summary.invitedCount > 0 ? `${summary.invitedCount} invited` : "",
        summary.bannedCount > 0 ? `${summary.bannedCount} banned` : "",
        summary.roomCount > 0 ? `${summary.roomCount} ${summary.roomCount === 1 ? "room" : "rooms"}` : "",
        summary.encrypted ? "encrypted" : "",
        summary.alias,
      ]
        .filter(Boolean)
        .join("  ·  ")
    : "";

  return (
    <ScrollArea className={s.tabScroll} contentClassName={cx(s.overview, mobile && s.mOverview)}>
      <div className={s.topRow}>
        <div
          className={cx(s.photoBox, canManage && s.photoLive)}
          onPointerEnter={() => setHover(true)}
          onPointerLeave={() => setHover(false)}
          onClick={pick}
          onDragOver={(e) => canManage && e.preventDefault()}
          onDrop={(e) => {
            if (!canManage) return;
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f && /^image\//.test(f.type)) spaceActions.applyPhoto(f);
          }}
          role={canManage ? "button" : undefined}
          aria-label={canManage ? "Change photo" : undefined}
        >
          <Avatar size={96} radius={24} name={serverName} seed={spaceId || serverName} imageSource={summary?.avatar} />
          {canManage && mobile && (
            <span className={s.photoBadge} aria-hidden>
              <Icon name="insert-image-symbolic" size={16} color="var(--th-space-settings-photo-badge-icon)" />
            </span>
          )}
          {canManage && !mobile && (
            <div className={s.photoHover} style={{ opacity: hover ? 1 : 0 }}>
              <Icon name="insert-image-symbolic" size={20} color="var(--th-space-settings-photo-icon)" hovered={hover} />
              <span>Change photo</span>
            </div>
          )}
          {canManage && summary?.avatar && (
            <ToolButton
              className={s.photoRemove}
              iconName="dialog-close-symbolic"
              iconSize={12}
              tip="Remove photo"
              onClick={(e) => {
                e.stopPropagation();
                spaceActions.applyPhoto(null);
              }}
            />
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) spaceActions.applyPhoto(f);
              e.target.value = "";
            }}
          />
        </div>
        <div className={s.fieldsCol}>
          <SectionLabel>Name</SectionLabel>
          <TextField
            placeholder="Space name"
            value={name}
            disabled={!canManage}
            onChange={(e) => setName(e.target.value)}
            onAccepted={() => dirty && canManage && name.trim() && save()}
            aria-label="Space name"
          />
          <SectionLabel className={s.mt4}>Topic</SectionLabel>
          <TextArea
            className={s.topicArea}
            placeholder="What this space is for"
            value={topic}
            disabled={!canManage}
            onChange={(e) => setTopic(e.target.value)}
            aria-label="Topic"
          />
          {!canManage && <HintLabel>Only people with Manage space can change these.</HintLabel>}
          {dirty && canManage && (
            <div className={s.saveRow}>
              <GlowButton text="Save changes" busy={busy} disabled={busy || !name.trim()} onClick={save} />
              <Button flat text="Discard" onClick={discard} />
              <span className={s.fill} />
            </div>
          )}
        </div>
      </div>
      <Separator className={s.max720} />
      <SectionLabel>Who can join</SectionLabel>
      <RadioButton
        name={`jr-${spaceId}`}
        text="Invite only — people need an invite"
        checked={joinRule !== "public"}
        disabled={!canManage}
        onToggled={(on) => on && joinRule === "public" && spaceActions.applyJoinRule("invite")}
      />
      <RadioButton
        name={`jr-${spaceId}`}
        text="Anyone with the link"
        checked={joinRule === "public"}
        disabled={!canManage}
        onToggled={(on) => on && joinRule !== "public" && spaceActions.applyJoinRule("public")}
      />
      {joinRule === "restricted" && (
        <HintLabel className={s.max720}>Right now members of a parent space can join on their own (restricted). Picking an option above replaces that.</HintLabel>
      )}
      {joinRule === "knock" && <HintLabel className={s.max720}>Right now people can knock to ask for an invite. Picking an option above replaces that.</HintLabel>}
      <Separator className={s.max720} />
      <SectionLabel>Space link</SectionLabel>
      <div className={cx(s.linkRow, s.max720)}>
        <TextField className={s.grow} readOnly value={link} placeholder="No link yet" aria-label="Space link" onFocus={(e) => e.currentTarget.select()} />
        <Button
          text="Copy"
          icon="edit-copy-symbolic"
          disabled={!link}
          onClick={async () => {
            if (await copyText(link)) toast("Space link copied", { timeoutMs: 2500 });
          }}
        />
      </div>
      <HintLabel className={s.max720}>{joinRule === "public" ? "Anyone with this link can join." : "People with this link still need an invite."}</HintLabel>
      <Separator className={s.max720} />
      <div className={s.stats}>{stats}</div>
      <div style={{ height: 8, flex: "none" }} />
      {onLeave && (
        <button type="button" className={cx(s.leave, s.mLeave)} onClick={onLeave}>
          <Icon name="go-previous-symbolic" size={16} color="var(--th-space-settings-leave-fg)" />
          <span>Leave space</span>
        </button>
      )}
    </ScrollArea>
  );
}

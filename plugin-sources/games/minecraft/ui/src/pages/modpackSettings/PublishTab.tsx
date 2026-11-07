// The Publish tab of the instance settings, for an instance that tracks a pack published on NiHao: name, visibility, invites, detach, delete. The state and the handlers belong to the modal; this draws them.
import { t } from "@shared/components/Translate";
import { OptionRow } from "@shared";
import TrashIcon from "@shared/assets/icons/trash.svg?react";
import ExternalLinkIcon from "@shared/assets/icons/external-link.svg?react";
import CloudAnimIcon from "@shared/assets/icons/cloud.svg?react";
import CheckIcon from "@shared/assets/icons/check.svg?react";
import LayersIcon from "@shared/assets/icons/layers.svg?react";
import GlobeIcon from "@shared/assets/icons/globe.svg?react";
import PersonPlusIcon from "@shared/assets/icons/person-plus.svg?react";
import { ModpackProfile } from "../types";

export function PublishTab({
  pack,
  signedIn,
  publishInfo,
  publishInfoLoading,
  publishInfoError,
  publishName,
  setPublishName,
  publishVisibility,
  setPublishVisibility,
  savingPublish,
  handleSavePublish,
  inviteLogin,
  setInviteLogin,
  inviting,
  handleInvite,
  setConfirmDetach,
  detaching,
  setConfirmDeletePack,
  deletingPack,
}: {
  pack: NonNullable<ModpackProfile["pack"]>;
  signedIn: boolean;
  publishInfo: { visibility: string; is_owner: boolean; latest_build: number } | null;
  publishInfoLoading: boolean;
  publishInfoError: string | null;
  publishName: string;
  setPublishName: (name: string) => void;
  publishVisibility: "public" | "invite";
  setPublishVisibility: (visibility: "public" | "invite") => void;
  savingPublish: boolean;
  handleSavePublish: () => void;
  inviteLogin: string;
  setInviteLogin: (login: string) => void;
  inviting: boolean;
  handleInvite: () => void;
  setConfirmDetach: (open: boolean) => void;
  detaching: boolean;
  setConfirmDeletePack: (open: boolean) => void;
  deletingPack: boolean;
}) {
  return (
    <div className="settings-tab">
      <OptionRow icon={<CloudAnimIcon className="settings-icon" />} label={t("minecraft.modpack_settings.publish_id_label", "Pack ID")} hint={t("minecraft.modpack_settings.publish_id_hint", "The pack's identifier on the server and the number of its latest published build.")}>
        <span>{pack.id} · {t("minecraft.modpack_settings.publish_build_label", "build")} {pack.build}</span>
      </OptionRow>

      {!signedIn && (
        <p className="settings-hint">{t("minecraft.share.publish_signin_required", "Sign in to your NiHao account to publish modpacks.")}</p>
      )}
      {signedIn && publishInfoLoading && (
        <p className="settings-hint">{t("minecraft.modpack_settings.loading", "Loading...")}</p>
      )}
      {signedIn && publishInfoError && <p className="settings-form-error">{publishInfoError}</p>}
      {signedIn && !publishInfoLoading && !publishInfoError && !publishInfo && (
        <p className="settings-hint">
          {t(
            "minecraft.modpack_settings.publish_not_found",
            "This account can't see this pack on the server anymore — it may have been removed some other way. You can still detach it below."
          )}
        </p>
      )}

      {signedIn && publishInfo && !publishInfo.is_owner && (
        <p className="settings-hint">
          {t("minecraft.modpack_settings.publish_not_owner", "You're not the owner of this pack — only detaching is available here.")}
        </p>
      )}

      {signedIn && publishInfo && publishInfo.is_owner && (
        <>
          <OptionRow icon={<LayersIcon className="settings-icon" />} label={t("minecraft.modpack_settings.publish_name_label", "Pack name")} hint={t("minecraft.modpack_settings.publish_name_hint", "The name of the pack as other players see it in Public.")}>
            <input type="text" value={publishName} onChange={(e) => setPublishName(e.target.value)} />
          </OptionRow>

          <OptionRow icon={<GlobeIcon className="settings-icon" />} label={t("minecraft.modpack_settings.publish_visibility_label", "Visibility")} hint={t("minecraft.modpack_settings.publish_visibility_hint", "Public: anyone can find and download it. Invite-only: only players you invite.")}>
            <div className="settings-game-tabs">
              <button
                className={publishVisibility === "public" ? "active" : ""}
                onClick={() => setPublishVisibility("public")}
              >
                {t("minecraft.share.publish_visibility_public", "Public")}
              </button>
              <button
                className={publishVisibility === "invite" ? "active" : ""}
                onClick={() => setPublishVisibility("invite")}
              >
                {t("minecraft.share.publish_visibility_invite", "Invite-only")}
              </button>
            </div>
          </OptionRow>

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button className="settings-save-btn" onClick={handleSavePublish} disabled={savingPublish}>
              <CheckIcon />
              {savingPublish ? t("minecraft.modpack_settings.saving", "Saving...") : t("minecraft.modpack_settings.save", "Save")}
            </button>
          </div>

          {publishVisibility === "invite" && (
            <>
              <OptionRow icon={<PersonPlusIcon className="settings-icon" />} label={t("minecraft.modpack_settings.publish_invite_label", "Invite a player")} hint={t("minecraft.modpack_settings.publish_invite_hint", "Gives another player access to this invite-only pack. Enter their NiHao login.")}>
                <input
                  type="text"
                  value={inviteLogin}
                  onChange={(e) => setInviteLogin(e.target.value)}
                  placeholder={t("minecraft.modpack_settings.publish_invite_placeholder", "Login")}
                />
                <button className="settings-secondary-btn" onClick={handleInvite} disabled={inviting || !inviteLogin.trim()}>
                  {inviting ? t("minecraft.modpack_settings.publish_inviting", "Inviting...") : t("minecraft.modpack_settings.publish_invite_button", "Invite")}
                </button>
              </OptionRow>
            </>
          )}
        </>
      )}

      <OptionRow icon={<ExternalLinkIcon className="settings-icon" />} label={t("minecraft.modpack_settings.publish_detach_label", "Detach from NiHao")} hint={t("minecraft.modpack_settings.publish_detach_hint", "Stops this instance tracking the published pack. Doesn't touch the server — the pack, its builds, and everyone else's copy stay exactly as they are; only this local instance forgets it published it.")}>
        <button className="settings-secondary-btn modpack-danger-btn" onClick={() => setConfirmDetach(true)} disabled={detaching}>
          {t("minecraft.modpack_settings.publish_detach", "Detach")}
        </button>
      </OptionRow>

      {publishInfo?.is_owner && (
        <OptionRow icon={<TrashIcon className="settings-icon" />} label={t("minecraft.modpack_settings.publish_delete_label", "Delete from NiHao")} hint={t("minecraft.modpack_settings.publish_delete_hint", "Permanently deletes this pack from the server — every published build, its icon/banner, and everyone else's ability to download it. Irreversible.")}>
          <button className="settings-secondary-btn modpack-danger-btn" onClick={() => setConfirmDeletePack(true)} disabled={deletingPack}>
            {t("minecraft.modpack_settings.publish_delete", "Delete pack")}
          </button>
        </OptionRow>
      )}
    </div>
  );
}

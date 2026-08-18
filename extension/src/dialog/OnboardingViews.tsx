import React from "react";

const ERROR_MESSAGE_ID = "onboarding-error-view-message";

// --- WelcomeView ---

export interface WelcomeViewProps {
  onStart: () => void;
  hasUsedBefore?: boolean;
}

export function WelcomeView({ onStart, hasUsedBefore }: WelcomeViewProps) {
  return (
    <div className="moo-onboarding-view">
      <h2 className="moo-onboarding-view__heading">歡迎使用家庭書櫃</h2>
      <p className="moo-onboarding-view__body">
        {hasUsedBefore
          ? "偵測到你曾使用過家庭書櫃，請重新設定以繼續。"
          : "一鍵開始，自動同步你的讀墨帳號與書單。"}
      </p>
      <button
        onClick={onStart}
        className="moo-button moo-button--block moo-button--lg moo-onboarding-view__primary moo-onboarding-view__primary--welcome"
      >
        {hasUsedBefore ? "繼續使用" : "開始使用"}
      </button>
      <p className="moo-onboarding-view__note">
        我們僅讀取你的帳號信箱用於生成匿名識別碼，信箱不會上傳至伺服器。
      </p>
    </div>
  );
}

// --- CreatedView ---

export interface CreatedViewProps {
  generatedSyncCode: string;
  copied: boolean;
  onCopy: () => void;
  onContinue: () => void;
}

export function CreatedView({
  generatedSyncCode,
  copied,
  onCopy,
  onContinue,
}: CreatedViewProps) {
  const copyClass = copied
    ? "moo-button moo-button--outline moo-onboarding-view__copy moo-onboarding-view__copy--copied"
    : "moo-button moo-button--outline moo-onboarding-view__copy";
  return (
    <div className="moo-onboarding-view">
      <h2 className="moo-onboarding-view__heading">家庭公開書櫃已建立</h2>
      <p className="moo-onboarding-view__body moo-onboarding-view__body--gap16">
        將以下同步碼分享給家人，他們可以用此代碼加入你的公開書櫃。
      </p>
      <div className="moo-onboarding-view__code-box">
        <span
          data-testid="sync-code"
          className="moo-onboarding-view__code-text"
        >
          {generatedSyncCode}
        </span>
      </div>
      <button onClick={onCopy} className={copyClass}>
        {copied ? "已複製" : "複製同步碼"}
      </button>
      <button
        onClick={onContinue}
        className="moo-button moo-button--block moo-onboarding-view__primary"
      >
        繼續
      </button>
    </div>
  );
}

// --- ErrorView ---

export interface ErrorAction {
  label: string;
  variant?: "primary" | "secondary";
  onClick: () => void;
}

export interface ErrorViewProps {
  errorMessage: string;
  actions: ErrorAction[];
}

export function ErrorView({ errorMessage, actions }: ErrorViewProps) {
  return (
    <div className="moo-onboarding-view">
      <h2 className="moo-onboarding-view__heading moo-onboarding-view__heading--error">
        發生錯誤
      </h2>
      <p id={ERROR_MESSAGE_ID} className="moo-onboarding-view__body">
        {errorMessage}
      </p>
      <div role="group" aria-describedby={ERROR_MESSAGE_ID}>
        {actions.map((action) => {
          const isSecondary = action.variant === "secondary";
          const className = isSecondary
            ? "moo-button moo-button--outline moo-button--block moo-onboarding-view__secondary"
            : "moo-button moo-button--block moo-onboarding-view__primary moo-onboarding-view__primary--gap8";
          return (
            <button
              key={action.label}
              onClick={action.onClick}
              className={className}
            >
              {action.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// IdleView is the only stateful onboarding view (it calls
// useSyncCodeHostVerdict), so it lives in its own module. This re-export is
// permanent: it is the public surface that Onboarding.tsx and
// OnboardingViews.test.tsx import from.
export { IdleView } from "./IdleView";
export type { IdleViewProps } from "./IdleView";

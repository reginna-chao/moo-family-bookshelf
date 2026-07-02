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
      <button onClick={onStart} className="moo-onboarding-view__primary moo-onboarding-view__primary--welcome">
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

export function CreatedView({ generatedSyncCode, copied, onCopy, onContinue }: CreatedViewProps) {
  const copyClass = copied
    ? "moo-onboarding-view__copy moo-onboarding-view__copy--copied"
    : "moo-onboarding-view__copy";
  return (
    <div className="moo-onboarding-view">
      <h2 className="moo-onboarding-view__heading">家庭公開書櫃已建立</h2>
      <p className="moo-onboarding-view__body moo-onboarding-view__body--gap16">
        將以下同步碼分享給家人，他們可以用此代碼加入你的公開書櫃。
      </p>
      <div className="moo-onboarding-view__code-box">
        <span data-testid="sync-code" className="moo-onboarding-view__code-text">
          {generatedSyncCode}
        </span>
      </div>
      <button onClick={onCopy} className={copyClass}>
        {copied ? "已複製" : "複製同步碼"}
      </button>
      <button onClick={onContinue} className="moo-onboarding-view__primary">
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
            ? "moo-onboarding-view__secondary"
            : "moo-onboarding-view__primary moo-onboarding-view__primary--gap8";
          return (
            <button key={action.label} onClick={action.onClick} className={className}>
              {action.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// --- IdleView ---

type OnboardingState = string;

export interface IdleViewProps {
  state: OnboardingState;
  syncCodeInput: string;
  isProcessing: boolean;
  onSetSyncCodeInput: (value: string) => void;
  onCreate: () => void;
  onJoin: () => void;
}

export function IdleView({
  state,
  syncCodeInput,
  isProcessing,
  onSetSyncCodeInput,
  onCreate,
  onJoin,
}: IdleViewProps) {
  const createClass = isProcessing
    ? "moo-onboarding-view__create moo-onboarding-view__create--busy"
    : "moo-onboarding-view__create";
  const joinDisabled = !syncCodeInput.trim() || isProcessing;
  const joinClass = joinDisabled
    ? "moo-onboarding-view__join moo-onboarding-view__join--disabled"
    : "moo-onboarding-view__join";
  return (
    <div className="moo-onboarding-view">
      <h2 className="moo-onboarding-view__heading">歡迎使用家庭書櫃</h2>
      <p className="moo-onboarding-view__body">
        建立或加入家庭公開書櫃，與家人分享你的藏書。
      </p>
      <button onClick={onCreate} disabled={isProcessing} className={createClass}>
        {state === "creating" ? "建立中..." : "建立家庭公開書櫃"}
      </button>
      <div className="moo-onboarding-view__divider">或</div>
      <div className="moo-onboarding-view__input-wrap">
        <input
          type="text"
          autoComplete="off"
          placeholder="輸入家庭同步碼"
          value={syncCodeInput}
          onChange={(e) => onSetSyncCodeInput(e.target.value)}
          disabled={isProcessing}
          className="moo-onboarding-view__input"
        />
      </div>
      <button onClick={onJoin} disabled={joinDisabled} className={joinClass}>
        {state === "joining" ? "加入中..." : "加入家庭公開書櫃"}
      </button>
      <p className="moo-onboarding-view__note moo-onboarding-view__note--lh">
        將同步碼分享給家人即可加入書櫃。
      </p>
    </div>
  );
}

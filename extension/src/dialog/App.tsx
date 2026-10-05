import React, { useState, useEffect, useRef, useCallback } from "react";
import browser from "webextension-polyfill";
import { Inbox, Library, BookOpen, Settings } from "lucide-react";
import { ApiClient, BorrowStatus } from "../api/client";
import {
  USER_ID_KEY,
  AUTH_TOKEN_KEY,
  HAS_COMPLETED_INITIAL_SETUP_KEY,
  DEFAULT_API_ENDPOINT,
} from "../constants";
import { readFamilyId } from "../storage/familyId";
import { readStoredApiEndpoint } from "../storage/familyEndpointChoice";
import { safeStorageGet } from "../storage/safeStorage";
import { applyStoredEndpoint } from "./applyStoredEndpoint";
import { clearStoredFamilyBinding } from "./familyBindingReset";
import { checkAccountIdentity } from "./accountIdentityCheck";
import { useAccountGate } from "./useAccountGate";
import { AccountCheckProvider } from "./AccountCheckContext";
import { AccountMismatchScreen } from "./AccountMismatchScreen";
import { familyGoneNoticeText } from "./familyGoneNotice";
import { Onboarding } from "./Onboarding";
import { PersonalShelf } from "./PersonalShelf";
import { FamilyShelf } from "./FamilyShelf";
import { FamilySettings } from "./FamilySettings";
import { BorrowTab } from "./BorrowTab";
import { DialogFooter } from "./DialogFooter";
import { useTokenRefresh } from "./useTokenRefresh";
import { useReauth } from "./useReauth";
import { ReauthModal } from "./ReauthModal";
import { isExtensionContextValid } from "../utils/extensionContext";
import { FamilyDataProvider, useFamilyData } from "./FamilyDataContext";
import { VersionWarning } from "./VersionWarning";
import { LoadingState } from "./LoadingState";
import { useIsMobile } from "../hooks/useIsMobile";

export type View = "loading" | "onboarding" | "main" | "account-mismatch";
type Tab = "family-shelf" | "personal-shelf" | "borrow" | "settings";

interface AppProps {
  /**
   * Notifies the host (content script) of the current top-level view so it can
   * adjust the dialog container's layout — e.g. only the "main" view uses a
   * fixed desktop height; "loading"/"onboarding" size to their content.
   */
  onViewChange?: (view: View) => void;
  /**
   * Notifies the host of the incoming PENDING borrow count so it can keep the
   * floating button badge live. Only fires while the main view (and its
   * FamilyDataProvider) is mounted.
   */
  onPendingBorrowCountChange?: (count: number) => void;
}

export function App({
  onViewChange,
  onPendingBorrowCountChange,
}: AppProps = {}) {
  const [view, setView] = useState<View>("loading");
  const [activeTab, setActiveTab] = useState<Tab>("family-shelf");
  const [familyId, setFamilyId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [contextLost, setContextLost] = useState(false);
  // Why the family binding was torn down (removed by the owner / family gone /
  // full). Rendered above Onboarding so the forced flip has a stated reason
  // instead of looking like the dialog reset itself.
  const [familyGoneNotice, setFamilyGoneNotice] = useState<string | null>(null);
  // Bumped after a successful re-verification so FamilyDataProvider re-runs its
  // initial load (members → bookshelf → borrow) and the stale 401 view clears
  // automatically, without a manual "重試" tap.
  const [reloadSignal, setReloadSignal] = useState(0);
  const apiClientRef = useRef(new ApiClient());
  // A teardown or join landing during the boot account check beats its result.
  const bootSupersededRef = useRef(false);
  // A late manual-sync mismatch may only leave the main view, never override another.
  const { accountCheck, settleAccount } = useAccountGate(userId, () =>
    setView((v) => (v === "main" ? "account-mismatch" : v)),
  );

  // Proactive token refresh — runs regardless of view state
  useTokenRefresh(apiClientRef.current);

  const handleReauthSuccess = useCallback(() => {
    setReloadSignal((n) => n + 1);
  }, []);

  // Re-verification prompt: shown when a dead token can only be recovered by
  // re-supplying the user's PWA-login verification secret (Invariant 2). Wires
  // apiClient.onReauthRequired; the overlay renders on top of the main view.
  const reauth = useReauth(apiClientRef.current, {
    onSuccess: handleReauthSuccess,
  });

  // Listen for FAMILY_REMOVED from ApiClient when token refresh fails
  // (e.g., KV data lost after wrangler dev restart, or user removed from family)
  useEffect(() => {
    const client = apiClientRef.current;
    client.onFamilyRemoved = (info) => {
      bootSupersededRef.current = true;
      client.setAuthToken(null);
      // Endpoint is family-scoped, as in handleLeaveFamily (storage half ran in
      // clearFamilyStorageAndBroadcast); the old server must not get the next join.
      client.setEndpoint(DEFAULT_API_ENDPOINT);
      setFamilyId(null);
      setUserId(null);
      setFamilyGoneNotice(familyGoneNoticeText(info.errorCode));
      setActiveTab("family-shelf");
      setView("onboarding");
    };
    return () => {
      client.onFamilyRemoved = null;
    };
  }, []);

  useEffect(() => {
    // If extension context is invalidated (e.g., extension updated/reloaded),
    // set state so the throw happens during render (error boundaries only catch render errors).
    if (!isExtensionContextValid()) {
      setContextLost(true);
      return;
    }

    // familyId, userId and endpoint come from DIRECT storage reads: background
    // messages are unreliable in Firefox (its event page sleeps).
    let cancelled = false;
    const identityCheck = new AbortController();
    void (async () => {
      try {
        const [familyId, storageResult, storedEndpoint] = await Promise.all([
          readFamilyId(),
          browser.storage.local.get([USER_ID_KEY, AUTH_TOKEN_KEY]),
          readStoredApiEndpoint(),
        ]);
        if (cancelled || bootSupersededRef.current) return;

        applyStoredEndpoint(apiClientRef.current, storedEndpoint);
        if (storageResult[AUTH_TOKEN_KEY]) {
          apiClientRef.current.setAuthToken(
            storageResult[AUTH_TOKEN_KEY] as string,
          );
        }
        if (familyId && storageResult[USER_ID_KEY]) {
          // Stays "loading" until the page's Readmoo account is checked (#271).
          const storedUserId = storageResult[USER_ID_KEY] as string;
          const identity = await checkAccountIdentity(
            storedUserId,
            identityCheck.signal,
          );
          if (cancelled || bootSupersededRef.current) return;
          settleAccount(identity, storedUserId);
          setFamilyId(familyId);
          setUserId(storedUserId);
          setView(identity === "mismatch" ? "account-mismatch" : "main");
        } else {
          setView("onboarding");
        }
      } catch {
        // Background asleep/unavailable or storage read failed after the
        // context-valid guard passed. Don't leave `view` stuck on "loading";
        // fall back to onboarding so the UI stays interactive.
        if (cancelled || bootSupersededRef.current) return;
        setView("onboarding");
      }
    })();
    return () => {
      cancelled = true;
      identityCheck.abort();
    };
  }, [settleAccount]);

  // Report the current view to the host so it can adapt the dialog container's
  // layout (only "main" uses a fixed desktop height; other views fit content).
  useEffect(() => {
    onViewChange?.(view);
  }, [view, onViewChange]);

  const handleFamilyJoined = (id: string, newUserId: string) => {
    bootSupersededRef.current = true;
    // Onboarding derived newUserId from the account on this page just now.
    settleAccount("match", newUserId);
    setFamilyId(id);
    setUserId(newUserId);
    // A fresh family supersedes the explanation of the previous one's teardown.
    setFamilyGoneNotice(null);
    // First-time onboarding: default to personal-shelf tab
    void (async () => {
      const result = await safeStorageGet([HAS_COMPLETED_INITIAL_SETUP_KEY]);
      if (!result[HAS_COMPLETED_INITIAL_SETUP_KEY]) {
        setActiveTab("personal-shelf");
        void browser.storage.local
          .set({ [HAS_COMPLETED_INITIAL_SETUP_KEY]: true })
          .catch(() => {});
      }
    })();
    setView("main");
  };

  const handleLeaveFamily = () => {
    bootSupersededRef.current = true;
    // Storage half (direct removal + endpoint choice): see familyBindingReset.ts.
    // Account deletion reaches here after storage.local.clear(): a no-op then.
    clearStoredFamilyBinding().catch((err: unknown) => {
      console.warn("[App] Leave: local family cleanup failed", err);
    });
    // The endpoint is family-scoped; the live client must not keep the old one.
    apiClientRef.current.setEndpoint(DEFAULT_API_ENDPOINT);
    setFamilyId(null);
    setActiveTab("family-shelf");
    setView("onboarding");
  };

  const handleAccountForgotten = () => {
    setFamilyId(null);
    setUserId(null);
    setFamilyGoneNotice(null);
    setActiveTab("family-shelf");
    setView("onboarding");
  };

  // Throw during render so error boundary catches it
  if (contextLost) {
    throw new Error("Extension context invalidated");
  }

  if (view === "loading") {
    return <LoadingState message="載入中..." />;
  }

  if (view === "account-mismatch") {
    return (
      <AccountMismatchScreen
        apiClient={apiClientRef.current}
        onAccountForgotten={handleAccountForgotten}
      />
    );
  }

  if (view === "onboarding") {
    return (
      <div className="moo-app__fill">
        {familyGoneNotice && (
          <div role="alert" className="moo-family-gone-notice">
            <div className="moo-family-gone-notice__text">
              {familyGoneNotice}
            </div>
            <div className="moo-family-gone-notice__actions">
              <button
                onClick={() => setFamilyGoneNotice(null)}
                className="moo-button moo-button--ghost moo-button--xs"
              >
                關閉
              </button>
            </div>
          </div>
        )}
        <Onboarding
          onFamilyJoined={handleFamilyJoined}
          apiClient={apiClientRef.current}
        />
        <DialogFooter />
      </div>
    );
  }

  if (!familyId || !userId) {
    return null;
  }

  return (
    <AccountCheckProvider value={accountCheck}>
      <FamilyDataProvider
        familyId={familyId}
        userId={userId}
        apiClient={apiClientRef.current}
        reloadSignal={reloadSignal}
      >
        <MainContent
          familyId={familyId}
          userId={userId}
          apiClient={apiClientRef.current}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onLeave={handleLeaveFamily}
          onPendingBorrowCountChange={onPendingBorrowCountChange}
        />
      </FamilyDataProvider>
      {reauth.active && (
        <ReauthModal apiClient={apiClientRef.current} reauth={reauth} />
      )}
    </AccountCheckProvider>
  );
}

interface MainContentProps {
  familyId: string;
  userId: string;
  apiClient: ApiClient;
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  onLeave: () => void;
  onPendingBorrowCountChange?: (count: number) => void;
}

function MainContent({
  familyId,
  userId,
  apiClient,
  activeTab,
  onTabChange,
  onLeave,
  onPendingBorrowCountChange,
}: MainContentProps) {
  const {
    hasBookshelfUpdates,
    markBookshelfSeen,
    borrowRequests,
    borrowRequestsState,
  } = useFamilyData();
  const isMobile = useIsMobile();

  // Lazy-mount tab panels: mount a heavy child on its first visit, keep it mounted after.
  const [mountedTabs, setMountedTabs] = useState<Set<Tab>>(
    () => new Set<Tab>([activeTab]),
  );

  useEffect(() => {
    setMountedTabs((prev) =>
      prev.has(activeTab) ? prev : new Set(prev).add(activeTab),
    );
  }, [activeTab]);

  const handleTabChange = useCallback(
    (tab: Tab) => {
      if (tab === "family-shelf") {
        markBookshelfSeen();
      }
      onTabChange(tab);
    },
    [markBookshelfSeen, onTabChange],
  );

  const showRedDot = hasBookshelfUpdates;
  const incomingPendingCount = borrowRequests.filter(
    (r) => r.ownerId === userId && r.status === BorrowStatus.PENDING,
  ).length;

  // Report the incoming-pending count to the host so it can keep the floating
  // button badge live (including clearing it at 0). Never after unmount (effects
  // don't run post-unmount), so no cleanup is required.
  useEffect(() => {
    // Skip the initial load window: borrowRequests is [] until the fetch lands,
    // so reporting here would flash a transient 0 that clobbers the already-
    // correct badge (injected at mount) if the user opens+closes quickly.
    if (borrowRequestsState !== "loaded") return;
    onPendingBorrowCountChange?.(incomingPendingCount);
  }, [borrowRequestsState, incomingPendingCount, onPendingBorrowCountChange]);

  const tabs: Array<{ key: Tab; label: string; icon: React.ReactNode }> = [
    {
      key: "family-shelf",
      label: "家庭書櫃",
      icon: <Library size={14} aria-hidden="true" />,
    },
    {
      key: "personal-shelf",
      label: "個人書櫃",
      icon: <BookOpen size={14} aria-hidden="true" />,
    },
    {
      key: "borrow",
      label: "借閱",
      icon: <Inbox size={14} aria-hidden="true" />,
    },
    {
      key: "settings",
      label: "設定",
      icon: <Settings size={14} aria-hidden="true" />,
    },
  ];

  const tabsClass = isMobile ? "moo-tabs moo-tabs--mobile" : "moo-tabs";

  return (
    <div className="moo-app__fill">
      <VersionWarning apiClient={apiClient} />
      <nav role="tablist" className={tabsClass}>
        {tabs.map(({ key, label, icon }) => {
          const isActiveTab = activeTab === key;
          const tabClass = [
            "moo-tab",
            isMobile ? "moo-tab--mobile" : "",
            isActiveTab ? "moo-tab--active" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={key}
              id={`tab-${key}`}
              role="tab"
              aria-selected={isActiveTab}
              aria-controls={`panel-${key}`}
              onClick={() => handleTabChange(key)}
              aria-label={
                key === "family-shelf" && showRedDot
                  ? "家庭書櫃（有新更新）"
                  : key === "borrow" && incomingPendingCount > 0
                    ? `借閱（${incomingPendingCount} 個待處理）`
                    : undefined
              }
              className={tabClass}
            >
              {icon}
              {label}
              {key === "family-shelf" && showRedDot && (
                <span aria-hidden="true" className="moo-tab__dot" />
              )}
              {key === "borrow" && incomingPendingCount > 0 && (
                <span aria-hidden="true" className="moo-tab__count">
                  {incomingPendingCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>
      <div className="moo-tab-panels">
        <div
          id="panel-family-shelf"
          role="tabpanel"
          aria-labelledby="tab-family-shelf"
          className={panelClass(activeTab === "family-shelf")}
        >
          {mountedTabs.has("family-shelf") && <FamilyShelf userId={userId} />}
        </div>
        <div
          id="panel-personal-shelf"
          role="tabpanel"
          aria-labelledby="tab-personal-shelf"
          className={panelClass(activeTab === "personal-shelf")}
        >
          {mountedTabs.has("personal-shelf") && (
            <PersonalShelf userId={userId} apiClient={apiClient} />
          )}
        </div>
        <div
          id="panel-borrow"
          role="tabpanel"
          aria-labelledby="tab-borrow"
          className={panelClass(activeTab === "borrow")}
        >
          {mountedTabs.has("borrow") && (
            <BorrowTab userId={userId} apiClient={apiClient} />
          )}
        </div>
        <div
          id="panel-settings"
          role="tabpanel"
          aria-labelledby="tab-settings"
          className={panelClass(activeTab === "settings")}
        >
          {mountedTabs.has("settings") && (
            <FamilySettings
              familyId={familyId}
              userId={userId}
              apiClient={apiClient}
              onLeave={onLeave}
            />
          )}
        </div>
      </div>
      <DialogFooter />
    </div>
  );
}

/** Class for a tab panel; only the active panel is displayed. */
function panelClass(active: boolean): string {
  return active ? "moo-tab-panel moo-tab-panel--active" : "moo-tab-panel";
}

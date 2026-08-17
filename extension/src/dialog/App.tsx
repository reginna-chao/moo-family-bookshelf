import React, { useState, useEffect, useRef, useCallback } from "react";
import browser from "webextension-polyfill";
import { Inbox, Library, BookOpen, Settings } from "lucide-react";
import { ApiClient, BorrowStatus } from "../api/client";
import {
  USER_ID_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
  FAMILY_ID_KEY,
  HAS_COMPLETED_INITIAL_SETUP_KEY,
  DEFAULT_API_ENDPOINT,
} from "../constants";
import { readFamilyId } from "../storage/familyId";
import {
  readStoredApiEndpoint,
  resetFamilyEndpointChoice,
} from "../storage/familyEndpointChoice";
import { safeStorageGet } from "../storage/safeStorage";
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

export type View = "loading" | "onboarding" | "main";
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
  // Bumped after a successful re-verification so FamilyDataProvider re-runs its
  // initial load (members → bookshelf → borrow) and the stale 401 view clears
  // automatically, without a manual "重試" tap.
  const [reloadSignal, setReloadSignal] = useState(0);
  const apiClientRef = useRef(new ApiClient());

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
    client.onFamilyRemoved = () => {
      client.setAuthToken(null);
      setFamilyId(null);
      setUserId(null);
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

    // Load familyId, userId, and the accepted API endpoint on mount — all three
    // from DIRECT storage reads. Message round-trips are unreliable in Firefox,
    // whose non-persistent background event page sleeps; the endpoint used to
    // go through GET_API_ENDPOINT and silently fall back to the default, which
    // booted the dialog on the wrong backend for a member who had accepted a
    // custom one.
    let cancelled = false;
    void (async () => {
      try {
        const [familyId, storageResult, storedEndpoint] = await Promise.all([
          readFamilyId(),
          browser.storage.local.get([USER_ID_KEY, AUTH_TOKEN_KEY]),
          readStoredApiEndpoint(),
        ]);
        if (cancelled) return;

        applyStoredEndpoint(apiClientRef.current, storedEndpoint);
        if (storageResult[AUTH_TOKEN_KEY]) {
          apiClientRef.current.setAuthToken(
            storageResult[AUTH_TOKEN_KEY] as string,
          );
        }
        if (familyId && storageResult[USER_ID_KEY]) {
          setFamilyId(familyId);
          setUserId(storageResult[USER_ID_KEY] as string);
          setView("main");
        } else {
          setView("onboarding");
        }
      } catch {
        // Background asleep/unavailable or storage read failed after the
        // context-valid guard passed. Don't leave `view` stuck on "loading";
        // fall back to onboarding so the UI stays interactive.
        if (cancelled) return;
        setView("onboarding");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Report the current view to the host so it can adapt the dialog container's
  // layout (only "main" uses a fixed desktop height; other views fit content).
  useEffect(() => {
    onViewChange?.(view);
  }, [view, onViewChange]);

  const handleFamilyJoined = (id: string, newUserId: string) => {
    setFamilyId(id);
    setUserId(newUserId);
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
    // CLEAR_FAMILY_ID can fail in Firefox (sleeping background event page), so
    // also clear familyId + auth credentials DIRECTLY from storage to guarantee
    // Unbind Isolation (no leftover familyId/token readable after leave).
    void browser.runtime.sendMessage({ type: "CLEAR_FAMILY_ID" });
    void browser.storage.local.remove([
      FAMILY_ID_KEY,
      AUTH_TOKEN_KEY,
      TOKEN_EXPIRES_AT_KEY,
    ]);
    // The API endpoint is a FAMILY-scoped setting — the owner picks it, every
    // member adopts it — so it must not outlive the membership. Reset the stored
    // choice AND the live client: a family-less client still pointed at the old
    // family's server would send the next create/join (userId, display name, the
    // token that server issues, the whole personal book list) there, and would
    // bake that host into the sync code it then hands out. Account deletion
    // reaches this same handler after a storage.local.clear(), where the storage
    // half is simply a no-op.
    void resetFamilyEndpointChoice();
    apiClientRef.current.setEndpoint(DEFAULT_API_ENDPOINT);
    void (async () => {
      try {
        await browser.storage.sync.remove(FAMILY_ID_KEY);
      } catch {
        // sync storage may be unavailable (e.g. Firefox without sync)
      }
    })();
    setFamilyId(null);
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

  if (view === "onboarding") {
    return (
      <div className="moo-app__fill">
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
    <>
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
    </>
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

/**
 * Point the client at the endpoint the user has accepted, if any.
 *
 * A stored value the client refuses (hand-edited storage, or written by an
 * older build with looser rules) must not derail the whole boot read into the
 * catch below — that would drop a member with a family into onboarding. Degrade
 * to the default endpoint instead.
 */
function applyStoredEndpoint(client: ApiClient, endpoint: string | null): void {
  if (endpoint === null) return;
  try {
    client.setEndpoint(endpoint);
  } catch (err) {
    console.warn("[App] Ignoring unusable stored API endpoint", err);
  }
}

/** Class for a tab panel; only the active panel is displayed. */
function panelClass(active: boolean): string {
  return active ? "moo-tab-panel moo-tab-panel--active" : "moo-tab-panel";
}

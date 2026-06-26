import React, { useState, useEffect, useRef, useCallback } from "react";
import browser from "webextension-polyfill";
import { Inbox } from "lucide-react";
import { ApiClient, BorrowStatus } from "../api/client";
import {
  USER_ID_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
  FAMILY_ID_KEY,
  HAS_COMPLETED_INITIAL_SETUP_KEY,
} from "../constants";
import { readFamilyId } from "../storage/familyId";
import { Onboarding } from "./Onboarding";
import { PersonalShelf } from "./PersonalShelf";
import { FamilyShelf } from "./FamilyShelf";
import { FamilySettings } from "./FamilySettings";
import { BorrowTab } from "./BorrowTab";
import { DialogFooter } from "./DialogFooter";
import { useTokenRefresh } from "./useTokenRefresh";
import { isExtensionContextValid } from "../utils/extensionContext";
import { FamilyDataProvider, useFamilyData } from "./FamilyDataContext";
import { VersionWarning } from "./VersionWarning";
import { LoadingState } from "./LoadingState";
import { useIsMobile } from "../hooks/useIsMobile";

type View = "loading" | "onboarding" | "main";
type Tab = "family-shelf" | "personal-shelf" | "borrow" | "settings";

/**
 * Horizontal space (px) reserved at the tab row's right edge on mobile so the
 * content-script close icon (X at top:8px right:8px, 32x32) never overlaps the
 * last tab. 8 (offset) + 32 (icon width) = 40.
 */
const CLOSE_ICON_RESERVED_PX = 40;

const flexColumnFill: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minHeight: 0,
};

export function App() {
  const [view, setView] = useState<View>("loading");
  const [activeTab, setActiveTab] = useState<Tab>("family-shelf");
  const [familyId, setFamilyId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [contextLost, setContextLost] = useState(false);
  const apiClientRef = useRef(new ApiClient());

  // Proactive token refresh — runs regardless of view state
  useTokenRefresh(apiClientRef.current);

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

    // Load familyId, userId, and custom API endpoint on mount.
    // familyId + userId come from DIRECT storage reads (reliable in Firefox,
    // where the non-persistent background event page sleeps and its message
    // round-trips fail). The API endpoint still goes through the background
    // message, but its result is decoupled so a rejected/undefined response
    // falls back to the default endpoint instead of forcing onboarding.
    let cancelled = false;
    void (async () => {
      try {
        const [familyId, storageResult, apiResult] = await Promise.all([
          readFamilyId(),
          browser.storage.local.get([USER_ID_KEY, AUTH_TOKEN_KEY]),
          Promise.resolve(
            browser.runtime.sendMessage({ type: "GET_API_ENDPOINT" }) as Promise<
              { apiEndpoint?: string } | undefined
            >,
          ).catch(() => undefined),
        ]);
        if (cancelled) return;

        if (apiResult?.apiEndpoint) {
          apiClientRef.current.setEndpoint(apiResult.apiEndpoint);
        }
        if (storageResult[AUTH_TOKEN_KEY]) {
          apiClientRef.current.setAuthToken(storageResult[AUTH_TOKEN_KEY] as string);
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

  const handleFamilyJoined = (id: string, newUserId: string) => {
    setFamilyId(id);
    setUserId(newUserId);
    // First-time onboarding: default to personal-shelf tab
    void (async () => {
      const result = await browser.storage.local.get([HAS_COMPLETED_INITIAL_SETUP_KEY]);
      if (!result[HAS_COMPLETED_INITIAL_SETUP_KEY]) {
        setActiveTab("personal-shelf");
        void browser.storage.local.set({ [HAS_COMPLETED_INITIAL_SETUP_KEY]: true });
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
      <div style={flexColumnFill}>
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
    <FamilyDataProvider familyId={familyId} userId={userId} apiClient={apiClientRef.current}>
      <MainContent
        familyId={familyId}
        userId={userId}
        apiClient={apiClientRef.current}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onLeave={handleLeaveFamily}
      />
    </FamilyDataProvider>
  );
}

interface MainContentProps {
  familyId: string;
  userId: string;
  apiClient: ApiClient;
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  onLeave: () => void;
}

function MainContent({
  familyId,
  userId,
  apiClient,
  activeTab,
  onTabChange,
  onLeave,
}: MainContentProps) {
  const { hasBookshelfUpdates, markBookshelfSeen, borrowRequests } = useFamilyData();
  const isMobile = useIsMobile();

  // Lazy-mount tab panels: mount a heavy child on its first visit, keep it mounted after.
  const [mountedTabs, setMountedTabs] = useState<Set<Tab>>(() => new Set<Tab>([activeTab]));

  useEffect(() => {
    setMountedTabs((prev) => (prev.has(activeTab) ? prev : new Set(prev).add(activeTab)));
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

  const tabs: Array<{ key: Tab; label: string; icon?: React.ReactNode }> = [
    { key: "family-shelf", label: "家庭書櫃" },
    { key: "personal-shelf", label: "個人書櫃" },
    { key: "borrow", label: "借閱", icon: <Inbox size={14} aria-hidden="true" /> },
    { key: "settings", label: "設定" },
  ];

  // Mobile-only tab sizing: tighter buttons + right padding so the content-script
  // close icon never overlaps the last tab. Desktop values are unchanged.
  const tabRowPaddingRight = isMobile ? CLOSE_ICON_RESERVED_PX : 0;
  const tabButtonPadding = isMobile ? "8px 0" : "12px 0";
  const tabButtonFontSize = isMobile ? 13 : 14;

  return (
    <div style={flexColumnFill}>
      <VersionWarning apiClient={apiClient} />
      <nav
        role="tablist"
        style={{
          display: "flex",
          borderBottom: "1px solid #e2e8f0",
          alignItems: "center",
          paddingRight: tabRowPaddingRight,
        }}
      >
        {tabs.map(({ key, label, icon }) => (
          <button
            key={key}
            id={`tab-${key}`}
            role="tab"
            aria-selected={activeTab === key}
            aria-controls={`panel-${key}`}
            onClick={() => handleTabChange(key)}
            aria-label={
              key === "family-shelf" && showRedDot
                ? "家庭書櫃（有新更新）"
                : key === "borrow" && incomingPendingCount > 0
                  ? `借閱（${incomingPendingCount} 個待處理）`
                  : undefined
            }
            style={{
              flex: 1,
              padding: tabButtonPadding,
              border: "none",
              background: activeTab === key ? "#eff6ff" : "transparent",
              fontWeight: activeTab === key ? 600 : 400,
              color: activeTab === key ? "#2563eb" : "#64748b",
              cursor: "pointer",
              fontSize: tabButtonFontSize,
              borderBottom:
                activeTab === key ? "2px solid #2563eb" : "2px solid transparent",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
            }}
          >
            {icon}
            {label}
            {key === "family-shelf" && showRedDot && (
              <span
                aria-hidden="true"
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: "#ef4444",
                  marginLeft: 4,
                  verticalAlign: "middle",
                }}
              />
            )}
            {key === "borrow" && incomingPendingCount > 0 && (
              <span
                aria-hidden="true"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  minWidth: 16,
                  height: 16,
                  padding: "0 4px",
                  borderRadius: 8,
                  background: "#dc2626",
                  color: "white",
                  fontSize: 11,
                  fontWeight: 600,
                  marginLeft: 4,
                  lineHeight: 1,
                }}
              >
                {incomingPendingCount}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div style={{ padding: 16, overflowY: "auto", flex: 1, minHeight: 0 }}>
        <div id="panel-family-shelf" role="tabpanel" aria-labelledby="tab-family-shelf" style={{ display: activeTab === "family-shelf" ? "block" : "none" }}>
          {mountedTabs.has("family-shelf") && <FamilyShelf userId={userId} />}
        </div>
        <div id="panel-personal-shelf" role="tabpanel" aria-labelledby="tab-personal-shelf" style={{ display: activeTab === "personal-shelf" ? "block" : "none" }}>
          {mountedTabs.has("personal-shelf") && <PersonalShelf userId={userId} apiClient={apiClient} />}
        </div>
        <div id="panel-borrow" role="tabpanel" aria-labelledby="tab-borrow" style={{ display: activeTab === "borrow" ? "block" : "none" }}>
          {mountedTabs.has("borrow") && <BorrowTab userId={userId} apiClient={apiClient} />}
        </div>
        <div id="panel-settings" role="tabpanel" aria-labelledby="tab-settings" style={{ display: activeTab === "settings" ? "block" : "none" }}>
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


import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { Library, BookOpen, Inbox, Settings, type LucideIcon } from "lucide-react";
import { useAuth, REMEMBER_SYNC_CODE_KEY, REMEMBERED_LOGOUT_KEY } from "./hooks/useAuth";
import { ApiClient } from "./api/client";
import { LandingPage } from "./pages/LandingPage";
import { FamilyShelfPage } from "./pages/FamilyShelfPage";
import { PersonalShelfPage } from "./pages/PersonalShelfPage";
import { BorrowPage } from "./pages/BorrowPage";
import { SettingsPage } from "./pages/SettingsPage";
import { InstallPrompt } from "./components/InstallPrompt";
import { PwaCreateNotice } from "./components/PwaCreateNotice";
import { VerifySetupPrompt } from "./components/VerifySetupPrompt";
import { FamilyDataProvider, useFamilyData } from "./hooks/useFamilyData";
import { VersionWarning } from "./components/VersionWarning";
import { getAppEnv } from "./utils/appEnv";
import { encodeSyncCode } from "@/crypto/syncCode";

type Page = "family-shelf" | "personal-shelf" | "borrow" | "settings";

const HASH_TO_PAGE: Record<string, Page> = {
  "#family-shelf": "family-shelf",
  "#personal-shelf": "personal-shelf",
  "#borrow": "borrow",
  "#settings": "settings",
};

const PAGE_TO_HASH: Record<Page, string> = {
  "family-shelf": "#family-shelf",
  "personal-shelf": "#personal-shelf",
  "borrow": "#borrow",
  "settings": "#settings",
};

/** Read page from hash, but only if it's a simple page hash (not auth params). */
function pageFromHash(): Page | null {
  const hash = window.location.hash;
  return HASH_TO_PAGE[hash] ?? null;
}

interface NavItem {
  page: Page;
  label: string;
  icon: LucideIcon;
}

const APP_ENV = getAppEnv();

const NAV_ITEMS: NavItem[] = [
  { page: "family-shelf", label: "家庭書櫃", icon: Library },
  { page: "personal-shelf", label: "個人書櫃", icon: BookOpen },
  { page: "borrow", label: "借閱", icon: Inbox },
  { page: "settings", label: "設定", icon: Settings },
];

export default function App() {
  const { auth, isLoading, login, logout, forceLogout, initialSyncCode, qrUserId, qrToken } = useAuth();
  const [currentPage, setCurrentPage] = useState<Page>(() => pageFromHash() ?? "family-shelf");
  const [familyFullError, setFamilyFullError] = useState("");
  const [verifySetupDone, setVerifySetupDone] = useState(false);

  // Sync page state with hash
  const navigate = useCallback((page: Page) => {
    setCurrentPage(page);
    window.history.replaceState(null, "", PAGE_TO_HASH[page]);
  }, []);

  // Listen for browser back/forward (hashchange)
  useEffect(() => {
    const handler = () => {
      const page = pageFromHash();
      if (page) setCurrentPage(page);
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  // Navigate to family shelf on login, but respect existing page hash on refresh
  const initialPageFromHash = useRef(pageFromHash());
  const prevAuthRef = useRef<typeof auth>(null);
  useEffect(() => {
    if (prevAuthRef.current === null && auth !== null) {
      if (initialPageFromHash.current) {
        initialPageFromHash.current = null; // Only skip once
      } else {
        navigate("family-shelf");
      }
    }
    prevAuthRef.current = auth;
  }, [auth, navigate]);

  // Re-join family to get a fresh token, used both on init and on 401 refresh
  const authRef = useRef(auth);
  authRef.current = auth;

  const acquireNewToken = useCallback(async (): Promise<string | null> => {
    const current = authRef.current;
    if (!current) return null;
    const tempClient = new ApiClient(current.apiHost);
    // Refresh endpoint is protected — include current token for authentication
    if (current.authToken) {
      tempClient.setAuthToken(current.authToken);
    }
    const res = await tempClient.joinFamily(current.familyId, current.userId, {});
    if (res.error) {
      if (res.error.code === "FAMILY_FULL") {
        setFamilyFullError("家庭成員已達上限（每個家庭最多 2 位成員）");
      } else if (res.error.code === "VERIFICATION_REQUIRED" && current.familyId) {
        // Preserve sync code so LandingPage can pre-fill and show verification UI.
        // Respect the user's "remember sync code" preference.
        if (localStorage.getItem(REMEMBER_SYNC_CODE_KEY) !== "0") {
          try {
            const code = encodeSyncCode({
              familyId: current.familyId,
              apiHost: current.apiHost,
            });
            localStorage.setItem(REMEMBERED_LOGOUT_KEY, code);
          } catch { /* best-effort */ }
        }
      }
      logout();
      return null;
    }
    if (res.data?.authToken) {
      login({ ...current, authToken: res.data.authToken });
      return res.data.authToken;
    }
    return null;
  }, [login, logout]);

  const apiClient = useMemo(() => {
    const client = new ApiClient(auth?.apiHost);
    if (auth?.authToken) {
      client.setAuthToken(auth.authToken);
    }
    client.setTokenRefresher(acquireNewToken);
    return client;
  }, [auth?.apiHost, auth?.authToken, acquireNewToken]);

  // Auto-acquire auth token if missing (e.g., QR code entry)
  const [acquiringToken, setAcquiringToken] = useState(false);
  const tokenAcquired = useRef(false);
  useEffect(() => {
    if (!auth || auth.authToken || tokenAcquired.current) return;
    tokenAcquired.current = true;
    setAcquiringToken(true);

    void acquireNewToken().finally(() => setAcquiringToken(false));
  }, [auth, acquireNewToken]);


  if (isLoading || acquiringToken) {
    return (
      <div className="max-w-md mx-auto min-h-screen flex items-center justify-center">
        <p className="text-gray-500">載入中...</p>
      </div>
    );
  }

  if (!auth) {
    return (
      <LandingPage
        onAuth={(data) => {
          setFamilyFullError("");
          login(data);
        }}
        initialSyncCode={initialSyncCode}
        qrUserId={qrUserId}
        qrToken={qrToken}
        externalError={familyFullError}
      />
    );
  }

  return (
    <FamilyDataProvider
      familyId={auth.familyId}
      userId={auth.userId}
      apiClient={apiClient}
    >
      {!verifySetupDone && (
        <VerifySetupPrompt
          userId={auth.userId}
          apiClient={apiClient}
          onComplete={() => setVerifySetupDone(true)}
        />
      )}
      <MainContent
        auth={auth}
        apiClient={apiClient}
        currentPage={currentPage}
        navigate={navigate}
        logout={logout}
        forceLogout={forceLogout}
      />
    </FamilyDataProvider>
  );
}

interface MainContentProps {
  auth: NonNullable<ReturnType<typeof useAuth>["auth"]>;
  apiClient: ApiClient;
  currentPage: Page;
  navigate: (page: Page) => void;
  logout: () => void;
  forceLogout: () => void;
}

function MainContent({
  auth,
  apiClient,
  currentPage,
  navigate,
  logout,
  forceLogout,
}: MainContentProps) {
  const familyData = useFamilyData();
  const { hasBookshelfUpdates, markBookshelfSeen } = familyData;
  // incomingPendingCount may be missing in older test mocks — default to 0.
  const incomingPendingCount = familyData.incomingPendingCount ?? 0;

  const handleNavigate = useCallback(
    (page: Page) => {
      if (page === "family-shelf") {
        markBookshelfSeen();
      }
      navigate(page);
    },
    [markBookshelfSeen, navigate],
  );

  const showRedDot = hasBookshelfUpdates;
  const showBorrowBadge = incomingPendingCount > 0;

  return (
    <div className="max-w-md mx-auto min-h-screen flex flex-col bg-gray-50">
      <VersionWarning apiClient={apiClient} />
      <PwaCreateNotice userId={auth.userId} onDismiss={() => {}} />
      <InstallPrompt userId={auth.userId} />
      <main className="flex-1 overflow-y-auto pb-16">
        {currentPage === "family-shelf" && (
          <FamilyShelfPage userId={auth.userId} />
        )}
        {currentPage === "personal-shelf" && (
          <PersonalShelfPage userId={auth.userId} apiClient={apiClient} />
        )}
        {currentPage === "borrow" && (
          <BorrowPage userId={auth.userId} apiClient={apiClient} />
        )}
        {currentPage === "settings" && (
          <SettingsPage
            familyId={auth.familyId}
            userId={auth.userId}
            apiClient={apiClient}
            onLogout={logout}
            onForceLogout={forceLogout}
          />
        )}
      </main>

      <nav
        aria-label="主要導覽"
        className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200"
      >
        <div className="max-w-md mx-auto flex relative">
          {NAV_ITEMS.map((item) => {
            const ariaLabel =
              item.page === "family-shelf" && showRedDot
                ? "家庭書櫃（有新更新）"
                : item.page === "borrow" && showBorrowBadge
                  ? `借閱（${incomingPendingCount} 個待處理）`
                  : undefined;
            return (
              <button
                key={item.page}
                onClick={() => handleNavigate(item.page)}
                aria-label={ariaLabel}
                aria-current={currentPage === item.page ? "page" : undefined}
                className={`flex-1 flex flex-col items-center py-2 text-xs transition-colors ${
                  currentPage === item.page
                    ? "text-blue-600 font-semibold"
                    : "text-gray-500"
                }`}
              >
                <span className="relative">
                  <item.icon size={20} aria-hidden="true" className="mb-0.5" />
                  {item.page === "family-shelf" && showRedDot && (
                    <span aria-hidden="true" className="absolute -top-0.5 -right-1 w-2 h-2 bg-red-500 rounded-full" />
                  )}
                  {item.page === "borrow" && showBorrowBadge && (
                    <span
                      aria-hidden="true"
                      className="absolute -top-1 -right-2 min-w-[16px] h-4 px-1 bg-red-500 text-white text-[10px] rounded-full flex items-center justify-center"
                    >
                      {incomingPendingCount}
                    </span>
                  )}
                </span>
                <span>{item.label}</span>
              </button>
            );
          })}
          {APP_ENV !== "prod" && (
            <span
              className={`absolute -top-2 right-2 text-xs font-bold px-1.5 py-0 rounded-full leading-4 ${
                APP_ENV === "local"
                  ? "bg-red-100 text-red-700 border border-red-300"
                  : "bg-blue-100 text-blue-700 border border-blue-300"
              }`}
            >
              {APP_ENV === "local" ? "LOCAL" : "DEV"}
            </span>
          )}
        </div>
      </nav>
    </div>
  );
}

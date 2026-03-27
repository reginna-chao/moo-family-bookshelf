import { useState, useMemo, useEffect, useRef } from "react";
import { useAuth } from "./hooks/useAuth";
import { ApiClient } from "./api/client";
import { LandingPage } from "./pages/LandingPage";
import { FamilyShelfPage } from "./pages/FamilyShelfPage";
import { PersonalShelfPage } from "./pages/PersonalShelfPage";
import { SettingsPage } from "./pages/SettingsPage";

type Page = "family-shelf" | "personal-shelf" | "settings";

interface NavItem {
  page: Page;
  label: string;
  icon: string;
}

const NAV_ITEMS: NavItem[] = [
  { page: "family-shelf", label: "家庭書櫃", icon: "📚" },
  { page: "personal-shelf", label: "個人書櫃", icon: "📖" },
  { page: "settings", label: "設定", icon: "⚙️" },
];

export default function App() {
  const { auth, isLoading, login, logout } = useAuth();
  const [currentPage, setCurrentPage] = useState<Page>("family-shelf");

  const apiClient = useMemo(() => {
    const client = new ApiClient(auth?.apiHost);
    if (auth?.authToken) {
      client.setAuthToken(auth.authToken);
    }
    return client;
  }, [auth?.apiHost, auth?.authToken]);

  // Auto-acquire auth token if missing (e.g., QR code entry)
  const tokenAcquired = useRef(false);
  useEffect(() => {
    if (!auth || auth.authToken || tokenAcquired.current) return;
    tokenAcquired.current = true;

    const acquireToken = async () => {
      // Re-join the family to get a token (server handles idempotent re-join)
      const tempClient = new ApiClient(auth.apiHost);
      const res = await tempClient.joinFamily(auth.familyId, auth.userId);
      if (res.data) {
        const data = res.data as unknown as { authToken?: string };
        if (data.authToken) {
          login({ ...auth, authToken: data.authToken });
        }
      }
    };
    void acquireToken();
  }, [auth, login]);

  if (isLoading) {
    return (
      <div className="max-w-md mx-auto min-h-screen flex items-center justify-center">
        <p className="text-gray-500">載入中...</p>
      </div>
    );
  }

  if (!auth) {
    return <LandingPage onAuth={login} />;
  }

  return (
    <div className="max-w-md mx-auto min-h-screen flex flex-col bg-gray-50">
      <main className="flex-1 overflow-y-auto pb-16">
        {currentPage === "family-shelf" && (
          <FamilyShelfPage
            familyId={auth.familyId}
            userId={auth.userId}
            apiClient={apiClient}
            encryptionKey={auth.encryptionKey}
          />
        )}
        {currentPage === "personal-shelf" && (
          <PersonalShelfPage userId={auth.userId} apiClient={apiClient} encryptionKey={auth.encryptionKey} />
        )}
        {currentPage === "settings" && (
          <SettingsPage
            familyId={auth.familyId}
            userId={auth.userId}
            apiClient={apiClient}
            encryptionKey={auth.encryptionKey}
            onLogout={logout}
          />
        )}
      </main>

      <nav
        aria-label="主要導覽"
        className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200"
      >
        <div className="max-w-md mx-auto flex">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.page}
              onClick={() => setCurrentPage(item.page)}
              aria-current={currentPage === item.page ? "page" : undefined}
              className={`flex-1 flex flex-col items-center py-2 text-xs transition-colors ${
                currentPage === item.page
                  ? "text-blue-600 font-semibold"
                  : "text-gray-500"
              }`}
            >
              <span aria-hidden="true" className="text-xl mb-0.5">
                {item.icon}
              </span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

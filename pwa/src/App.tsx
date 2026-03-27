import { useState } from "react";
import { LandingPage } from "./pages/LandingPage";
import { FamilyShelfPage } from "./pages/FamilyShelfPage";
import { PersonalShelfPage } from "./pages/PersonalShelfPage";
import { SettingsPage } from "./pages/SettingsPage";

type Page = "landing" | "family-shelf" | "personal-shelf" | "settings";

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
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [currentPage, setCurrentPage] = useState<Page>("landing");

  if (!isAuthenticated) {
    return <LandingPage onAuth={() => {
      setIsAuthenticated(true);
      setCurrentPage("family-shelf");
    }} />;
  }

  return (
    <div className="max-w-md mx-auto min-h-screen flex flex-col bg-gray-50">
      <main className="flex-1 overflow-y-auto pb-16">
        {currentPage === "family-shelf" && <FamilyShelfPage />}
        {currentPage === "personal-shelf" && <PersonalShelfPage />}
        {currentPage === "settings" && <SettingsPage />}
      </main>

      <nav aria-label="主要導覽" className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200">
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
              <span aria-hidden="true" className="text-xl mb-0.5">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

import React, { useState, useEffect } from "react";

type View = "loading" | "onboarding" | "main";
type Tab = "family-shelf" | "personal-shelf" | "settings";

export function App() {
  const [view, setView] = useState<View>("loading");
  const [activeTab, setActiveTab] = useState<Tab>("family-shelf");
  const [familyId, setFamilyId] = useState<string | null>(null);

  useEffect(() => {
    // Check if user has a family
    chrome.runtime.sendMessage({ type: "GET_FAMILY_ID" }, (response) => {
      if (response?.familyId) {
        setFamilyId(response.familyId);
        setView("main");
      } else {
        setView("onboarding");
      }
    });
  }, []);

  const handleFamilyJoined = (id: string) => {
    setFamilyId(id);
    setView("main");
  };

  const handleLeaveFamily = () => {
    chrome.runtime.sendMessage({ type: "CLEAR_FAMILY_ID" });
    setFamilyId(null);
    setView("onboarding");
  };

  if (view === "loading") {
    return <div style={{ padding: 24, textAlign: "center" }}>載入中...</div>;
  }

  if (view === "onboarding") {
    return <Onboarding onFamilyJoined={handleFamilyJoined} />;
  }

  return (
    <div>
      <nav style={{ display: "flex", borderBottom: "1px solid #e2e8f0" }}>
        {(
          [
            ["family-shelf", "家庭書櫃"],
            ["personal-shelf", "個人書櫃"],
            ["settings", "設定"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            style={{
              flex: 1,
              padding: "12px 0",
              border: "none",
              background: activeTab === key ? "#eff6ff" : "transparent",
              fontWeight: activeTab === key ? 600 : 400,
              color: activeTab === key ? "#2563eb" : "#64748b",
              cursor: "pointer",
              fontSize: 14,
              borderBottom:
                activeTab === key ? "2px solid #2563eb" : "2px solid transparent",
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      <div style={{ padding: 16, overflowY: "auto", maxHeight: "60vh" }}>
        {activeTab === "family-shelf" && (
          <FamilyShelf familyId={familyId!} />
        )}
        {activeTab === "personal-shelf" && <PersonalShelf />}
        {activeTab === "settings" && (
          <FamilySettings
            familyId={familyId!}
            onLeave={handleLeaveFamily}
          />
        )}
      </div>
    </div>
  );
}

// --- Placeholder components (to be expanded) ---

function Onboarding({
  onFamilyJoined,
}: {
  onFamilyJoined: (id: string) => void;
}) {
  const [syncCode, setSyncCode] = useState("");

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
        歡迎使用家庭書櫃
      </h2>
      <p style={{ color: "#64748b", marginBottom: 24, fontSize: 14 }}>
        此功能需要先建立或加入家庭才能使用。
      </p>
      <button
        onClick={() => onFamilyJoined("new-family-" + Date.now())}
        style={{
          width: "100%",
          padding: 12,
          marginBottom: 12,
          border: "none",
          borderRadius: 8,
          background: "#2563eb",
          color: "white",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        建立新家庭
      </button>
      <div style={{ textAlign: "center", margin: "12px 0", color: "#94a3b8" }}>
        或
      </div>
      <input
        type="text"
        placeholder="輸入家庭同步碼"
        value={syncCode}
        onChange={(e) => setSyncCode(e.target.value)}
        style={{
          width: "100%",
          padding: 12,
          border: "1px solid #e2e8f0",
          borderRadius: 8,
          marginBottom: 12,
          boxSizing: "border-box",
          fontSize: 14,
        }}
      />
      <button
        onClick={() => {
          if (syncCode.trim()) {
            onFamilyJoined(syncCode.trim());
          }
        }}
        disabled={!syncCode.trim()}
        style={{
          width: "100%",
          padding: 12,
          border: "1px solid #2563eb",
          borderRadius: 8,
          background: "transparent",
          color: "#2563eb",
          fontWeight: 600,
          cursor: syncCode.trim() ? "pointer" : "not-allowed",
          opacity: syncCode.trim() ? 1 : 0.5,
        }}
      >
        加入家庭
      </button>
    </div>
  );
}

function FamilyShelf({ familyId }: { familyId: string }) {
  return (
    <div>
      <p style={{ color: "#64748b", fontSize: 14 }}>
        家庭 ID: {familyId}
      </p>
      <p style={{ color: "#94a3b8", marginTop: 16, textAlign: "center" }}>
        尚無家人分享書籍
      </p>
    </div>
  );
}

function PersonalShelf() {
  return (
    <div>
      <p style={{ color: "#94a3b8", textAlign: "center" }}>
        載入個人書單中...
      </p>
    </div>
  );
}

function FamilySettings({
  familyId,
  onLeave,
}: {
  familyId: string;
  onLeave: () => void;
}) {
  return (
    <div>
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>
        家庭設定
      </h3>
      <div
        style={{
          padding: 12,
          background: "#f8fafc",
          borderRadius: 8,
          marginBottom: 16,
          fontSize: 14,
        }}
      >
        <div style={{ color: "#64748b", marginBottom: 4 }}>同步碼</div>
        <code style={{ fontSize: 13 }}>{familyId}</code>
      </div>
      <button
        onClick={onLeave}
        style={{
          width: "100%",
          padding: 12,
          border: "1px solid #ef4444",
          borderRadius: 8,
          background: "transparent",
          color: "#ef4444",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        離開家庭
      </button>
    </div>
  );
}

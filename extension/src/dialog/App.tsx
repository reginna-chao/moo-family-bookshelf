import React, { useState, useEffect, useRef } from "react";
import { ApiClient } from "../api/client";
import { Onboarding } from "./Onboarding";
import { PersonalShelf } from "./PersonalShelf";
import { FamilyShelf } from "./FamilyShelf";
import { FamilySettings } from "./FamilySettings";
import { DialogFooter } from "./DialogFooter";
import { useTokenRefresh } from "./useTokenRefresh";
import { isExtensionContextValid } from "../utils/extensionContext";

type View = "loading" | "onboarding" | "main";
type Tab = "family-shelf" | "personal-shelf" | "settings";

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
    // GET_FAMILY_ID checks sync first, falling back to local (handled in background).
    chrome.runtime.sendMessage({ type: "GET_FAMILY_ID" }, (familyResponse) => {
      chrome.storage.local.get(["userId", "authToken"], (storageResult) => {
        chrome.runtime.sendMessage({ type: "GET_API_ENDPOINT" }, (apiResponse) => {
          if (apiResponse?.apiEndpoint) {
            apiClientRef.current.setEndpoint(apiResponse.apiEndpoint);
          }
          if (storageResult.authToken) {
            apiClientRef.current.setAuthToken(storageResult.authToken as string);
          }
          if (familyResponse?.familyId && storageResult.userId) {
            setFamilyId(familyResponse.familyId);
            setUserId(storageResult.userId as string);
            setView("main");
          } else {
            setView("onboarding");
          }
        });
      });
    });
  }, []);

  const handleFamilyJoined = (id: string, newUserId: string) => {
    setFamilyId(id);
    setUserId(newUserId);
    setView("main");
  };

  const handleLeaveFamily = () => {
    chrome.runtime.sendMessage({ type: "CLEAR_FAMILY_ID" });
    chrome.storage.local.remove("tokenExpiresAt");
    setFamilyId(null);
    setActiveTab("family-shelf");
    setView("onboarding");
  };

  // Throw during render so error boundary catches it
  if (contextLost) {
    throw new Error("Extension context invalidated");
  }

  if (view === "loading") {
    return <div style={{ padding: 24, textAlign: "center" }}>載入中...</div>;
  }

  if (view === "onboarding") {
    return (
      <div>
        <Onboarding
          onFamilyJoined={handleFamilyJoined}
          apiClient={apiClientRef.current}
        />
        <DialogFooter minimal />
      </div>
    );
  }

  if (!familyId || !userId) {
    return null;
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
        <div style={{ display: activeTab === "family-shelf" ? "block" : "none" }}>
          <FamilyShelf familyId={familyId} userId={userId} apiClient={apiClientRef.current} />
        </div>
        <div style={{ display: activeTab === "personal-shelf" ? "block" : "none" }}>
          <PersonalShelf userId={userId} apiClient={apiClientRef.current} />
        </div>
        <div style={{ display: activeTab === "settings" ? "block" : "none" }}>
          <FamilySettings
            familyId={familyId}
            userId={userId}
            apiClient={apiClientRef.current}
            onLeave={handleLeaveFamily}
          />
        </div>
      </div>
      <DialogFooter />
    </div>
  );
}


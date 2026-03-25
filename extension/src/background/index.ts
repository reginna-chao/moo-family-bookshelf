/**
 * Chrome Extension Service Worker (background script).
 * Handles messaging between content script and extension internals.
 */

chrome.runtime.onInstalled.addListener(() => {
  console.log("MooFamily Bookshelf installed");
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_FAMILY_ID") {
    chrome.storage.local.get(["familyId"], (result) => {
      sendResponse({ familyId: result.familyId ?? null });
    });
    return true; // async response
  }

  if (message.type === "SET_FAMILY_ID") {
    chrome.storage.local.set({ familyId: message.familyId }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "CLEAR_FAMILY_ID") {
    chrome.storage.local.remove("familyId", () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "GET_API_ENDPOINT") {
    chrome.storage.local.get(["apiEndpoint"], (result) => {
      sendResponse({ apiEndpoint: result.apiEndpoint ?? null });
    });
    return true;
  }

  if (message.type === "SET_API_ENDPOINT") {
    chrome.storage.local.set({ apiEndpoint: message.apiEndpoint }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }
});

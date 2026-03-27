import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { ApiEndpointEditor } from "@/dialog/ApiEndpointEditor";
import type { ApiClient } from "@/api/client";
import { DEFAULT_API_ENDPOINT } from "../../src/constants";

vi.mock("@/constants", () => ({
  DEFAULT_API_ENDPOINT: "https://default-api.example.com",
}));

const DEFAULT_ENDPOINT = DEFAULT_API_ENDPOINT;

function createMockApiClient(endpoint = "https://custom.api.com") {
  return {
    getEndpoint: vi.fn().mockReturnValue(endpoint),
    setEndpoint: vi.fn(),
  } as unknown as ApiClient;
}

describe("ApiEndpointEditor", () => {
  let mockApiClient: ApiClient;

  beforeEach(() => {
    vi.useFakeTimers();
    mockApiClient = createMockApiClient();
    vi.mocked(chrome.runtime.sendMessage).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders collapsed by default with '進階設定' header", () => {
    render(<ApiEndpointEditor apiClient={mockApiClient} />);
    expect(screen.getByText(/進階設定/)).toBeInTheDocument();
    expect(screen.queryByText(/目前 API 端點/)).not.toBeInTheDocument();
  });

  it("expands on header click and shows current endpoint", () => {
    render(<ApiEndpointEditor apiClient={mockApiClient} />);
    fireEvent.click(screen.getByText(/進階設定/));
    expect(screen.getByText(/目前 API 端點/)).toBeInTheDocument();
    expect(screen.getByText("https://custom.api.com")).toBeInTheDocument();
  });

  it("shows input field and buttons when expanded", () => {
    render(<ApiEndpointEditor apiClient={mockApiClient} />);
    fireEvent.click(screen.getByText(/進階設定/));
    expect(
      screen.getByPlaceholderText("https://your-worker.example.com"),
    ).toBeInTheDocument();
    expect(screen.getByText("儲存")).toBeInTheDocument();
    expect(screen.getByText("重設為預設")).toBeInTheDocument();
  });

  it("saves valid URL and calls chrome.runtime.sendMessage with SET_API_ENDPOINT", () => {
    render(<ApiEndpointEditor apiClient={mockApiClient} />);
    fireEvent.click(screen.getByText(/進階設定/));

    const input = screen.getByPlaceholderText(
      "https://your-worker.example.com",
    );
    fireEvent.change(input, {
      target: { value: "https://my-worker.example.com" },
    });
    fireEvent.click(screen.getByText("儲存"));

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "SET_API_ENDPOINT",
      apiEndpoint: "https://my-worker.example.com",
    });
    expect(
      (mockApiClient.setEndpoint as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledWith("https://my-worker.example.com");
    expect(
      screen.getByText("https://my-worker.example.com"),
    ).toBeInTheDocument();
  });

  it("strips trailing slashes from the URL before saving", () => {
    render(<ApiEndpointEditor apiClient={mockApiClient} />);
    fireEvent.click(screen.getByText(/進階設定/));

    const input = screen.getByPlaceholderText(
      "https://your-worker.example.com",
    );
    fireEvent.change(input, {
      target: { value: "https://my-worker.example.com///" },
    });
    fireEvent.click(screen.getByText("儲存"));

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "SET_API_ENDPOINT",
      apiEndpoint: "https://my-worker.example.com",
    });
  });

  it("shows error for invalid URL and does not call sendMessage", () => {
    render(<ApiEndpointEditor apiClient={mockApiClient} />);
    fireEvent.click(screen.getByText(/進階設定/));

    const input = screen.getByPlaceholderText(
      "https://your-worker.example.com",
    );
    fireEvent.change(input, { target: { value: "not-a-url" } });
    fireEvent.click(screen.getByText("儲存"));

    expect(
      screen.getByText("請輸入有效的 HTTPS 網址（或 localhost）"),
    ).toBeInTheDocument();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("disables save button when input is empty", () => {
    render(<ApiEndpointEditor apiClient={mockApiClient} />);
    fireEvent.click(screen.getByText(/進階設定/));

    const saveButton = screen.getByText("儲存");
    expect(saveButton).toBeDisabled();
  });

  it("allows localhost URLs", () => {
    render(<ApiEndpointEditor apiClient={mockApiClient} />);
    fireEvent.click(screen.getByText(/進階設定/));

    const input = screen.getByPlaceholderText(
      "https://your-worker.example.com",
    );
    fireEvent.change(input, {
      target: { value: "http://localhost:8787" },
    });
    fireEvent.click(screen.getByText("儲存"));

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "SET_API_ENDPOINT",
      apiEndpoint: "http://localhost:8787",
    });
  });

  it("resets to default endpoint and calls sendMessage with null", () => {
    render(<ApiEndpointEditor apiClient={mockApiClient} />);
    fireEvent.click(screen.getByText(/進階設定/));

    fireEvent.click(screen.getByText("重設為預設"));

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "SET_API_ENDPOINT",
      apiEndpoint: null,
    });
    expect(
      (mockApiClient.setEndpoint as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledWith(DEFAULT_ENDPOINT);
    expect(screen.getByText(DEFAULT_ENDPOINT)).toBeInTheDocument();
  });

  it("disables reset button when already at default endpoint", () => {
    const defaultClient = createMockApiClient(DEFAULT_ENDPOINT);
    render(<ApiEndpointEditor apiClient={defaultClient} />);
    fireEvent.click(screen.getByText(/進階設定/));

    expect(screen.getByText("重設為預設")).toBeDisabled();
  });

  it("shows warning text when expanded", () => {
    render(<ApiEndpointEditor apiClient={mockApiClient} />);
    fireEvent.click(screen.getByText(/進階設定/));

    expect(
      screen.getByText(
        "變更 API 端點後，所有家庭成員都必須使用相同的端點",
      ),
    ).toBeInTheDocument();
  });

  it("shows '已儲存' feedback after saving and reverts after timeout", async () => {
    render(<ApiEndpointEditor apiClient={mockApiClient} />);
    fireEvent.click(screen.getByText(/進階設定/));

    const input = screen.getByPlaceholderText(
      "https://your-worker.example.com",
    );
    fireEvent.change(input, {
      target: { value: "https://new.api.com" },
    });
    fireEvent.click(screen.getByText("儲存"));

    expect(screen.getByText("已儲存")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.queryByText("已儲存")).not.toBeInTheDocument();
  });

  it("clears error when input changes", () => {
    render(<ApiEndpointEditor apiClient={mockApiClient} />);
    fireEvent.click(screen.getByText(/進階設定/));

    const input = screen.getByPlaceholderText(
      "https://your-worker.example.com",
    );
    fireEvent.change(input, { target: { value: "bad" } });
    fireEvent.click(screen.getByText("儲存"));
    expect(
      screen.getByText("請輸入有效的 HTTPS 網址（或 localhost）"),
    ).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "https://fixed.com" } });
    expect(
      screen.queryByText("請輸入有效的 HTTPS 網址（或 localhost）"),
    ).not.toBeInTheDocument();
  });

  it("collapses on second header click", () => {
    render(<ApiEndpointEditor apiClient={mockApiClient} />);
    fireEvent.click(screen.getByText(/進階設定/));
    expect(screen.getByText(/目前 API 端點/)).toBeInTheDocument();

    fireEvent.click(screen.getByText(/進階設定/));
    expect(screen.queryByText(/目前 API 端點/)).not.toBeInTheDocument();
  });
});

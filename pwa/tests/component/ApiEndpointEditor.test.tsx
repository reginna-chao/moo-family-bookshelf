import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ApiEndpointEditor } from "@/components/ApiEndpointEditor";
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
  let localStorageSetItem: ReturnType<typeof vi.fn>;
  let localStorageRemoveItem: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockApiClient = createMockApiClient();
    localStorageSetItem = vi.fn();
    localStorageRemoveItem = vi.fn();
    Object.defineProperty(window, "localStorage", {
      value: {
        getItem: vi.fn(),
        setItem: localStorageSetItem,
        removeItem: localStorageRemoveItem,
      },
      writable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders collapsed by default with '進階設定' header", () => {
    render(<ApiEndpointEditor apiClient={mockApiClient} userId="abc123" />);
    expect(screen.getByText(/進階設定/)).toBeInTheDocument();
    expect(screen.queryByText(/目前 API 端點/)).not.toBeInTheDocument();
  });

  it("expands on header click and shows current endpoint", () => {
    render(<ApiEndpointEditor apiClient={mockApiClient} userId="abc123" />);
    fireEvent.click(screen.getByText(/進階設定/));
    expect(screen.getByText(/目前 API 端點/)).toBeInTheDocument();
    expect(screen.getByText("https://custom.api.com")).toBeInTheDocument();
  });

  it("shows input field and buttons when expanded", () => {
    render(<ApiEndpointEditor apiClient={mockApiClient} userId="abc123" />);
    fireEvent.click(screen.getByText(/進階設定/));
    expect(
      screen.getByPlaceholderText("https://your-worker.example.com"),
    ).toBeInTheDocument();
    expect(screen.getByText("儲存")).toBeInTheDocument();
    expect(screen.getByText("重設為預設")).toBeInTheDocument();
  });

  it("saves valid URL, updates localStorage and apiClient", () => {
    render(<ApiEndpointEditor apiClient={mockApiClient} userId="abc123" />);
    fireEvent.click(screen.getByText(/進階設定/));

    const input = screen.getByPlaceholderText(
      "https://your-worker.example.com",
    );
    fireEvent.change(input, {
      target: { value: "https://my-worker.example.com" },
    });
    fireEvent.click(screen.getByText("儲存"));

    expect(localStorageSetItem).toHaveBeenCalledWith(
      "moo:abc123:apiHost",
      "https://my-worker.example.com",
    );
    expect(
      (mockApiClient.setEndpoint as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledWith("https://my-worker.example.com");
    expect(
      screen.getByText("https://my-worker.example.com"),
    ).toBeInTheDocument();
  });

  it("strips trailing slashes from the URL before saving", () => {
    render(<ApiEndpointEditor apiClient={mockApiClient} userId="abc123" />);
    fireEvent.click(screen.getByText(/進階設定/));

    const input = screen.getByPlaceholderText(
      "https://your-worker.example.com",
    );
    fireEvent.change(input, {
      target: { value: "https://my-worker.example.com///" },
    });
    fireEvent.click(screen.getByText("儲存"));

    expect(localStorageSetItem).toHaveBeenCalledWith(
      "moo:abc123:apiHost",
      "https://my-worker.example.com",
    );
  });

  it("shows error for invalid URL and does not save", () => {
    render(<ApiEndpointEditor apiClient={mockApiClient} userId="abc123" />);
    fireEvent.click(screen.getByText(/進階設定/));

    const input = screen.getByPlaceholderText(
      "https://your-worker.example.com",
    );
    fireEvent.change(input, { target: { value: "not-a-url" } });
    fireEvent.click(screen.getByText("儲存"));

    expect(
      screen.getByText("請輸入有效的 HTTPS 網址（或 localhost）"),
    ).toBeInTheDocument();
    expect(localStorageSetItem).not.toHaveBeenCalled();
  });

  it("disables save button when input is empty", () => {
    render(<ApiEndpointEditor apiClient={mockApiClient} userId="abc123" />);
    fireEvent.click(screen.getByText(/進階設定/));

    const saveButton = screen.getByText("儲存");
    expect(saveButton).toBeDisabled();
  });

  it("allows localhost URLs", () => {
    render(<ApiEndpointEditor apiClient={mockApiClient} userId="abc123" />);
    fireEvent.click(screen.getByText(/進階設定/));

    const input = screen.getByPlaceholderText(
      "https://your-worker.example.com",
    );
    fireEvent.change(input, {
      target: { value: "http://localhost:8787" },
    });
    fireEvent.click(screen.getByText("儲存"));

    expect(localStorageSetItem).toHaveBeenCalledWith(
      "moo:abc123:apiHost",
      "http://localhost:8787",
    );
  });

  it("resets to default: removes localStorage key and restores default endpoint", () => {
    render(<ApiEndpointEditor apiClient={mockApiClient} userId="abc123" />);
    fireEvent.click(screen.getByText(/進階設定/));

    fireEvent.click(screen.getByText("重設為預設"));

    expect(localStorageRemoveItem).toHaveBeenCalledWith("moo:abc123:apiHost");
    expect(
      (mockApiClient.setEndpoint as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledWith(DEFAULT_ENDPOINT);
    expect(screen.getByText(DEFAULT_ENDPOINT)).toBeInTheDocument();
  });

  it("disables reset button when already at default endpoint", () => {
    const defaultClient = createMockApiClient(DEFAULT_ENDPOINT);
    render(<ApiEndpointEditor apiClient={defaultClient} userId="abc123" />);
    fireEvent.click(screen.getByText(/進階設定/));

    expect(screen.getByText("重設為預設")).toBeDisabled();
  });

  it("shows warning text when expanded", () => {
    render(<ApiEndpointEditor apiClient={mockApiClient} userId="abc123" />);
    fireEvent.click(screen.getByText(/進階設定/));

    expect(
      screen.getByText(
        "變更 API 端點後，所有家庭成員都必須使用相同的端點",
      ),
    ).toBeInTheDocument();
  });

  it("shows '已儲存' feedback after saving and reverts after timeout", async () => {
    render(<ApiEndpointEditor apiClient={mockApiClient} userId="abc123" />);
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
    render(<ApiEndpointEditor apiClient={mockApiClient} userId="abc123" />);
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
    render(<ApiEndpointEditor apiClient={mockApiClient} userId="abc123" />);
    fireEvent.click(screen.getByText(/進階設定/));
    expect(screen.getByText(/目前 API 端點/)).toBeInTheDocument();

    fireEvent.click(screen.getByText(/進階設定/));
    expect(screen.queryByText(/目前 API 端點/)).not.toBeInTheDocument();
  });
});

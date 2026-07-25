import { useState, useEffect, useCallback, useRef } from "react";
import { Search, BookX, AlertCircle } from "lucide-react";
import { ApiClient } from "@/api/client";
import type { BookEntry, PublicShelfData } from "@/api/client";
import { DEFAULT_API_ENDPOINT } from "@/constants";

interface PublicShelfPageProps {
  shareToken: string;
}

type LoadState = "loading" | "loaded" | "not-found" | "invalid" | "error";

export function PublicShelfPage({ shareToken }: PublicShelfPageProps) {
  const [state, setState] = useState<LoadState>("loading");
  const [data, setData] = useState<PublicShelfData | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [debouncedTerm, setDebouncedTerm] = useState("");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const client = new ApiClient(DEFAULT_API_ENDPOINT);
      const result = await client.getPublicShelf(shareToken);
      setData(result);
      setState("loaded");
    } catch (e) {
      const status = (e as Error & { status?: number }).status;
      if (status === 404) setState("not-found");
      else if (status === 400) setState("invalid");
      else setState("error");
    }
  }, [shareToken]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedTerm(searchTerm), 300);
    return () => clearTimeout(debounceRef.current);
  }, [searchTerm]);

  if (state === "loading") return <LoadingView />;
  if (state === "not-found")
    return (
      <ErrorView
        icon={<BookX size={48} className="text-gray-300" />}
        message="此公開書櫃不存在或已過期"
      />
    );
  if (state === "invalid")
    return (
      <ErrorView
        icon={<AlertCircle size={48} className="text-gray-300" />}
        message="網址格式不正確"
      />
    );
  if (state === "error")
    return (
      <ErrorView
        icon={<AlertCircle size={48} className="text-gray-300" />}
        message="載入失敗，請稍後再試"
        onRetry={load}
      />
    );
  if (!data) return null;

  const term = debouncedTerm.toLowerCase();
  const filtered = term
    ? data.books.filter(
        (b) =>
          b.title.toLowerCase().includes(term) ||
          b.author.toLowerCase().includes(term),
      )
    : data.books;

  return (
    <div className="max-w-3xl mx-auto min-h-screen px-4 py-6">
      <p className="text-xs text-gray-400 mb-2">
        此為對外公開書櫃，無須登入即可瀏覽
      </p>
      <h1 className="text-xl font-bold text-gray-800 mb-4">{data.title}</h1>

      {data.books.length > 0 && (
        <div className="relative mb-4">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="搜尋書名或作者..."
            className="w-full pl-9 pr-3 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      )}

      {filtered.length === 0 && data.books.length > 0 && (
        <p className="text-center text-gray-400 py-8">找不到符合的書籍</p>
      )}

      {data.books.length === 0 && (
        <p className="text-center text-gray-400 py-12">
          此公開書櫃目前沒有書籍
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        {filtered.map((book) => (
          <BookCard key={book.bookId} book={book} />
        ))}
      </div>

      {data.expiresAt && (
        <p className="text-xs text-gray-400 mt-6 text-center">
          此書櫃將於 {new Date(data.expiresAt).toLocaleDateString("zh-TW")} 到期
        </p>
      )}
    </div>
  );
}

function BookCard({ book }: { book: BookEntry }) {
  const [imgError, setImgError] = useState(false);

  return (
    <a
      href={`https://readmoo.com/book/${book.bookId}`}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-lg border border-gray-100 overflow-hidden hover:shadow-md transition-shadow bg-white"
    >
      <div className="aspect-[3/4] bg-gray-100 relative">
        {!imgError ? (
          <img
            src={book.coverUrl}
            alt={book.title}
            loading="lazy"
            className="w-full h-full object-cover"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center p-2 bg-gray-50">
            <span className="text-xs text-gray-400 text-center line-clamp-3">
              {book.title}
            </span>
          </div>
        )}
      </div>
      <div className="p-2">
        <p className="text-sm font-medium text-gray-800 line-clamp-2 leading-tight">
          {book.title}
        </p>
        <p className="text-xs text-gray-500 mt-0.5 truncate">{book.author}</p>
      </div>
    </a>
  );
}

function LoadingView() {
  return (
    <div className="max-w-3xl mx-auto min-h-screen flex items-center justify-center">
      <div className="animate-spin w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full" />
    </div>
  );
}

function ErrorView({
  icon,
  message,
  onRetry,
}: {
  icon: React.ReactNode;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="max-w-3xl mx-auto min-h-screen flex flex-col items-center justify-center gap-4 px-4">
      {icon}
      <p className="text-gray-500 text-center">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium"
        >
          重試
        </button>
      )}
    </div>
  );
}

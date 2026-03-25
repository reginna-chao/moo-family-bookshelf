import React, { useState, useEffect, useCallback } from "react";
import { ApiClient, BookEntry } from "../api/client";
import { importKey, decrypt } from "../crypto/encrypt";
import { BookCard, BookWithMember, FilterButton } from "./BookCard";

export interface FamilyShelfProps {
  familyId: string;
  apiClient: ApiClient;
}

interface MemberBooks {
  userId: string;
  displayName: string;
  books: BookEntry[];
}

type LoadState = "loading" | "ready" | "error";

async function decryptMemberBooks(
  rawBooks: BookEntry[],
  encryptionKey: string,
): Promise<BookEntry[]> {
  try {
    const key = await importKey(encryptionKey);
    const results: BookEntry[] = [];
    for (const book of rawBooks) {
      try {
        const decrypted = await decrypt(book.title, key);
        const parsed = JSON.parse(decrypted) as BookEntry;
        results.push(parsed);
      } catch {
        results.push(book);
      }
    }
    return results;
  } catch {
    return rawBooks;
  }
}

function toBookWithMember(member: MemberBooks): BookWithMember[] {
  const name = member.displayName || member.userId.slice(0, 8);
  return member.books.map((b) => ({ ...b, memberName: name }));
}

export function FamilyShelf({ familyId, apiClient }: FamilyShelfProps) {
  const [members, setMembers] = useState<MemberBooks[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [filterMember, setFilterMember] = useState<string | null>(null);

  const loadBookshelf = useCallback(async () => {
    setState("loading");
    setErrorMessage("");

    const response = await apiClient.getFamilyBookshelf(familyId);
    if (response.error) {
      setErrorMessage(response.error.message);
      setState("error");
      return;
    }

    const data = response.data!;
    const storageResult = await chrome.storage.local.get(["encryptionKey"]);
    const encKey = storageResult.encryptionKey as string | undefined;

    const decryptedMembers: MemberBooks[] = [];
    for (const member of data.members) {
      const books = encKey
        ? await decryptMemberBooks(member.books, encKey)
        : member.books;
      decryptedMembers.push({
        userId: member.userId,
        displayName: member.displayName,
        books: books.filter((b) => b.isShared),
      });
    }

    setMembers(decryptedMembers);
    setState("ready");
  }, [familyId, apiClient]);

  useEffect(() => {
    void loadBookshelf();
  }, [loadBookshelf]);

  if (state === "loading") {
    return (
      <div style={{ padding: 24, textAlign: "center", color: "#94a3b8" }}>
        載入家庭書櫃中...
      </div>
    );
  }

  if (state === "error") {
    return (
      <div style={{ padding: 24, textAlign: "center" }}>
        <p style={{ color: "#ef4444", marginBottom: 16, fontSize: 14 }}>
          {errorMessage}
        </p>
        <button
          onClick={() => void loadBookshelf()}
          style={{
            padding: "8px 24px", border: "none", borderRadius: 8,
            background: "#2563eb", color: "white", fontWeight: 600, cursor: "pointer",
          }}
        >
          重試
        </button>
      </div>
    );
  }

  const allBooks = members.flatMap(toBookWithMember);
  const totalCount = allBooks.length;

  if (totalCount === 0) {
    return (
      <div style={{ padding: 24, textAlign: "center" }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>家庭開放書櫃</h3>
        <p style={{ color: "#94a3b8", fontSize: 14 }}>尚無家人分享書籍</p>
        <p style={{ color: "#cbd5e1", fontSize: 13, marginTop: 8 }}>
          家人可在個人書櫃中開啟分享功能，分享的書籍將會顯示在這裡。
        </p>
      </div>
    );
  }

  const visibleBooks = filterMember
    ? members.filter((m) => m.userId === filterMember).flatMap(toBookWithMember)
    : allBooks;

  return (
    <div>
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>家庭開放書櫃</h3>
      <p style={{ color: "#94a3b8", fontSize: 13, marginBottom: 12 }}>
        共 {totalCount} 本分享書籍
      </p>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        <FilterButton label="全部" active={filterMember === null} onClick={() => setFilterMember(null)} />
        {members.filter((m) => m.books.length > 0).map((m) => (
          <FilterButton
            key={m.userId}
            label={m.displayName || m.userId.slice(0, 8)}
            active={filterMember === m.userId}
            onClick={() => setFilterMember(m.userId)}
          />
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 12 }}>
        {visibleBooks.map((book) => (
          <BookCard key={`${book.bookId}-${book.memberName}`} book={book} />
        ))}
      </div>
    </div>
  );
}

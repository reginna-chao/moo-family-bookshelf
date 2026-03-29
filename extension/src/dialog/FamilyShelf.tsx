import React, { useState, useEffect, useCallback } from "react";
import { ApiClient, BookEntry, BoolFlag } from "../api/client";
import { importKey, decrypt } from "../crypto/encrypt";
import { BookCard, BookWithMember } from "./BookCard";
import { MemberDropdown, MemberFilterValue } from "./MemberDropdown";
import { SearchBar } from "./SearchBar";
import { useSearch } from "./useSearch";

export interface FamilyShelfProps {
  familyId: string;
  userId: string;
  apiClient: ApiClient;
}

interface MemberBooks {
  userId: string;
  displayName: string;
  books: BookEntry[];
}

/** Raw member shape returned by the bookshelf API */
interface RawMember {
  userId: string;
  payload: string | null;
  lastUpdated: string | null;
}

type LoadState = "loading" | "ready" | "error";

/**
 * Decrypt a member's encrypted payload into BookEntry[].
 * The payload is an AES-256-GCM encrypted JSON string containing
 * { userId, displayName, books, lastUpdated }.
 */
async function decryptPayload(
  payload: string,
  encryptionKey: string,
): Promise<{ displayName: string; books: BookEntry[] }> {
  const key = await importKey(encryptionKey);
  const decrypted = await decrypt(payload, key);
  const parsed = JSON.parse(decrypted) as {
    displayName?: string;
    books?: BookEntry[];
  };
  return {
    displayName: parsed.displayName ?? "",
    books: parsed.books ?? [],
  };
}

function toBookWithMember(member: MemberBooks): BookWithMember[] {
  const name = member.displayName || member.userId.slice(0, 8);
  return member.books.map((b) => ({ ...b, memberName: name }));
}

export function FamilyShelf({ familyId, userId, apiClient }: FamilyShelfProps) {
  const [members, setMembers] = useState<MemberBooks[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [filterMember, setFilterMember] = useState<MemberFilterValue>("all-except-self");

  const loadBookshelf = useCallback(async () => {
    setState("loading");
    setErrorMessage("");
    try {
      const response = await apiClient.getFamilyBookshelf(familyId);
      if (response.error) {
        setErrorMessage(response.error.message);
        setState("error");
        return;
      }

      const data = response.data as unknown as {
        familyId: string;
        members: RawMember[];
      };
      if (!data) {
        setState("ready");
        return;
      }

      const storageResult = await chrome.storage.local.get(["encryptionKey"]);
      const encKey = storageResult.encryptionKey as string | undefined;

      const decryptedMembers: MemberBooks[] = [];
      for (const member of data.members) {
        if (!member.payload || !encKey) {
          decryptedMembers.push({
            userId: member.userId,
            displayName: member.userId.slice(0, 8),
            books: [],
          });
          continue;
        }

        try {
          const { displayName, books } = await decryptPayload(
            member.payload,
            encKey,
          );
          decryptedMembers.push({
            userId: member.userId,
            displayName: displayName || member.userId.slice(0, 8),
            books: books.filter((b) => b.isShared === BoolFlag.TRUE),
          });
        } catch {
          // Decryption failed — skip this member's books
          decryptedMembers.push({
            userId: member.userId,
            displayName: member.userId.slice(0, 8),
            books: [],
          });
        }
      }

      setMembers(decryptedMembers);
      setState("ready");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "載入失敗");
      setState("error");
    }
  }, [familyId, apiClient]);

  useEffect(() => {
    void loadBookshelf();
  }, [loadBookshelf]);

  // Cross-component sync: update current user's display name when changed in settings
  useEffect(() => {
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area === "local" && changes.displayName) {
        const newName = (changes.displayName.newValue as string) ?? "";
        setMembers((prev) =>
          prev.map((m) =>
            m.userId === userId ? { ...m, displayName: newName } : m,
          ),
        );
      }
    };
    try {
      chrome.storage.onChanged.addListener(listener);
    } catch {
      // Extension context may be invalidated after reload
    }
    return () => {
      try {
        chrome.storage.onChanged.removeListener(listener);
      } catch {
        // Extension context may be invalidated after reload
      }
    };
  }, [userId]);

  const totalBooks = members.reduce((sum, m) => sum + m.books.length, 0);

  const memberFilteredBooks = (() => {
    if (filterMember === "all") {
      return members.flatMap(toBookWithMember);
    }
    if (filterMember === "all-except-self") {
      return members.filter((m) => m.userId !== userId).flatMap(toBookWithMember);
    }
    return members.filter((m) => m.userId === filterMember).flatMap(toBookWithMember);
  })();

  const { searchTerm, setSearchTerm, filteredItems: visibleBooks, isFiltering } =
    useSearch(memberFilteredBooks);

  if (state === "loading") {
    return (
      <div style={{ padding: 16, textAlign: "center", color: "#64748b" }}>
        載入家庭書櫃中...
      </div>
    );
  }

  if (state === "error") {
    return (
      <div style={{ padding: 16 }}>
        <p style={{ color: "#ef4444", fontSize: 14, marginBottom: 12 }}>
          {errorMessage}
        </p>
        <button
          onClick={() => void loadBookshelf()}
          style={{
            padding: "8px 16px",
            border: "1px solid #2563eb",
            borderRadius: 8,
            background: "transparent",
            color: "#2563eb",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          重試
        </button>
      </div>
    );
  }

  if (totalBooks === 0) {
    return (
      <div style={{ padding: 16, textAlign: "center" }}>
        <p style={{ color: "#94a3b8", marginTop: 16 }}>尚無家人分享書籍</p>
        <p style={{ color: "#cbd5e1", fontSize: 13, marginTop: 8 }}>
          家庭成員需在「個人書櫃」中開放書籍後才會出現在這裡
        </p>
      </div>
    );
  }

  return (
    <div>
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>
        家庭開放書櫃
        <span
          style={{
            fontWeight: 400,
            color: "#94a3b8",
            marginLeft: 8,
            fontSize: 13,
          }}
        >
          ({totalBooks} 本)
        </span>
      </h3>

      <SearchBar
        value={searchTerm}
        onChange={setSearchTerm}
        totalCount={memberFilteredBooks.length}
        filteredCount={visibleBooks.length}
        isFiltering={isFiltering}
      />

      <MemberDropdown
        members={members}
        userId={userId}
        value={filterMember}
        onChange={setFilterMember}
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))",
          gap: 12,
        }}
      >
        {visibleBooks.map((book) => (
          <BookCard key={`${book.memberName}-${book.bookId}`} book={book} />
        ))}
      </div>
    </div>
  );
}

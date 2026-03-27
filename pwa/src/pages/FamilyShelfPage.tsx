import type { ApiClient } from "@/api/client";

interface FamilyShelfPageProps {
  familyId: string;
  userId: string;
  apiClient: ApiClient;
}

export function FamilyShelfPage({
  familyId: _familyId,
  userId: _userId,
  apiClient: _apiClient,
}: FamilyShelfPageProps) {
  return (
    <div className="p-4">
      <h2 className="text-xl font-bold text-gray-900 mb-4">家庭書櫃</h2>
      <p className="text-gray-500 text-sm">
        家庭成員分享的書籍將顯示在這裡。
      </p>
    </div>
  );
}

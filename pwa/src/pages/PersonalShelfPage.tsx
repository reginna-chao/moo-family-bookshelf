import type { ApiClient } from "@/api/client";

interface PersonalShelfPageProps {
  userId: string;
  apiClient: ApiClient;
}

export function PersonalShelfPage({
  userId: _userId,
  apiClient: _apiClient,
}: PersonalShelfPageProps) {
  return (
    <div className="p-4">
      <h2 className="text-xl font-bold text-gray-900 mb-4">個人書櫃</h2>
      <p className="text-gray-500 text-sm">
        你的個人藏書與分享設定將顯示在這裡。
      </p>
    </div>
  );
}

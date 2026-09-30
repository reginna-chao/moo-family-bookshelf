import { Share2 } from "lucide-react";

export interface PersonalShelfHeaderProps {
  bookCount: number;
  onOpenPublicShare: () => void;
}

export function PersonalShelfHeader({
  bookCount,
  onOpenPublicShare,
}: PersonalShelfHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-xl font-bold text-gray-900">
        個人書櫃
        <span className="text-gray-400 text-sm font-normal ml-2">
          ({bookCount} 本)
        </span>
      </h2>
      <button
        onClick={() => onOpenPublicShare()}
        className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-blue-600 border border-blue-300 rounded-lg hover:bg-blue-50"
      >
        <Share2 size={13} /> 公開分享
      </button>
    </div>
  );
}

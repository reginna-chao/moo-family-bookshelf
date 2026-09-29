import { Pencil, Check, X } from "lucide-react";
import type { DisplayNameEditor } from "@/hooks/useDisplayNameEditor";

interface SettingsDisplayNameFieldProps {
  editor: DisplayNameEditor;
  userId: string;
}

/**
 * The 顯示名稱 row: the current name with an edit button, or the inline
 * editor. Stateless — the edit state is owned by `useDisplayNameEditor` in the
 * always-mounted personal section.
 */
export function SettingsDisplayNameField({
  editor,
  userId,
}: SettingsDisplayNameFieldProps) {
  const {
    editingName,
    setEditingName,
    nameInput,
    setNameInput,
    currentName,
    nameSaving,
    nameError,
    setNameError,
    handleSaveName,
  } = editor;

  return (
    <div className="mb-4">
      <p className="text-xs text-gray-500 mb-1">顯示名稱</p>
      {editingName ? (
        <div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              maxLength={20}
              placeholder="輸入顯示名稱"
              aria-label="顯示名稱"
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
            />
            <button
              onClick={() => void handleSaveName()}
              disabled={nameSaving}
              aria-label="確認修改名稱"
              className="p-1.5 text-blue-600 hover:text-blue-800 disabled:opacity-50"
            >
              <Check size={16} />
            </button>
            <button
              onClick={() => {
                setEditingName(false);
                setNameError(null);
              }}
              disabled={nameSaving}
              aria-label="取消修改名稱"
              className="p-1.5 text-gray-400 hover:text-gray-600 disabled:opacity-50"
            >
              <X size={16} />
            </button>
          </div>
          {nameError && (
            <p role="alert" className="text-red-500 text-xs mt-1">
              {nameError}
            </p>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-700">
            {currentName || userId.slice(0, 8)}
          </span>
          <button
            onClick={() => {
              setNameInput(currentName);
              setEditingName(true);
            }}
            aria-label="編輯顯示名稱"
            className="p-1 text-gray-400 hover:text-gray-600"
          >
            <Pencil size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

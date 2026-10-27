const EXPIRES_OPTIONS: Array<{ label: string; value: number | null }> = [
  { label: "7 天", value: 7 },
  { label: "30 天", value: 30 },
  { label: "60 天", value: 60 },
  { label: "90 天", value: 90 },
  { label: "永久", value: null },
];

export function ExpiresSelect({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
      過期時間
      <select
        value={value === null ? "null" : String(value)}
        onChange={(e) =>
          onChange(e.target.value === "null" ? null : Number(e.target.value))
        }
        className="moo-form-select rounded-lg border border-gray-300 pl-3 pr-9 py-2.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
      >
        {EXPIRES_OPTIONS.map((opt) => (
          <option
            key={String(opt.value)}
            value={opt.value === null ? "null" : String(opt.value)}
          >
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

import type { Dispatch, SetStateAction } from "react";

interface LandingEmailFieldProps {
  email: string;
  setEmail: Dispatch<SetStateAction<string>>;
  emailError: string;
  setEmailError: Dispatch<SetStateAction<string>>;
}

/** The login form's Readmoo account email input. */
export function LandingEmailField({
  email,
  setEmail,
  emailError,
  setEmailError,
}: LandingEmailFieldProps) {
  return (
    <div>
      <label
        htmlFor="email"
        className="block text-sm font-medium text-gray-700 mb-1"
      >
        讀墨帳號 Email
      </label>
      <input
        id="email"
        type="email"
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          if (emailError) setEmailError("");
        }}
        placeholder="your@email.com"
        aria-invalid={!!emailError || undefined}
        aria-describedby={emailError ? "email-error" : undefined}
        className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
      />
      {emailError && (
        <p id="email-error" className="text-red-500 text-xs mt-1">
          {emailError}
        </p>
      )}
    </div>
  );
}

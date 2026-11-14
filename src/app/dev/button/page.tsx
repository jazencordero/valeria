"use client";

import { useState } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/button";

const VARIANTS: ButtonVariant[] = ["primary", "secondary", "text", "icon"];
const SIZES: ButtonSize[] = ["sm", "md", "lg"];

function CloseIcon() {
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function Sample({
  variant,
  size,
  loading,
  disabled,
}: {
  variant: ButtonVariant;
  size: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
}) {
  const state = loading ? "loading" : disabled ? "disabled" : "default";
  const testId = `btn-${variant}-${size}-${state}`;
  if (variant === "icon") {
    return (
      <Button
        variant="icon"
        size={size}
        loading={loading}
        disabled={disabled}
        aria-label="Close"
        data-testid={testId}
      >
        <CloseIcon />
      </Button>
    );
  }
  return (
    <Button
      variant={variant}
      size={size}
      loading={loading}
      disabled={disabled}
      loadingLabel="Signing in"
      data-testid={testId}
    >
      Connect
    </Button>
  );
}

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export default function ButtonPage() {
  const [loading, setLoading] = useState(false);

  return (
    <main className="mx-auto max-w-4xl space-y-10 px-5 py-10">
      <header className="space-y-3">
        <h1 className="type-h30">Button</h1>
        <p className="ink-2">
          Four variants, three sizes, plus loading and disabled. Tab through to
          see the focus ring. Press and hold to feel the spring.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setTheme("light")}>
            Light
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setTheme("dark")}>
            Dark
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setTheme("system")}>
            System
          </Button>
        </div>
      </header>

      {(
        [
          ["Default", {}],
          ["Loading", { loading: true }],
          ["Disabled", { disabled: true }],
        ] as const
      ).map(([title, state]) => (
        <section key={title} className="space-y-3">
          <h2 className="type-h22">{title}</h2>
          <table className="border-separate border-spacing-x-4 border-spacing-y-3">
            <thead>
              <tr className="text-left">
                <th className="mono ink-3 font-normal">variant</th>
                {SIZES.map((size) => (
                  <th key={size} className="mono ink-3 font-normal">
                    {size}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {VARIANTS.map((variant) => (
                <tr key={variant}>
                  <td className="mono ink-2">{variant}</td>
                  {SIZES.map((size) => (
                    <td key={size} className="align-middle">
                      <Sample variant={variant} size={size} {...state} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      <section className="space-y-4">
        <h2 className="type-h22">Block and the loading swap</h2>
        <div className="max-w-sm space-y-3">
          <Button
            block
            size="lg"
            loading={loading}
            loadingLabel="Signing in"
            onClick={() => setLoading(true)}
            data-testid="btn-block"
          >
            Connect
          </Button>
          <Button block variant="secondary" onClick={() => setLoading(false)}>
            Reset
          </Button>
          <Button block variant="text" href="/dev/motion">
            Link that looks like a button
          </Button>
        </div>
      </section>
    </main>
  );
}

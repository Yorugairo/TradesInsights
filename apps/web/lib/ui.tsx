import type { CSSProperties, ReactNode } from "react";

export const table: CSSProperties = { borderCollapse: "collapse", width: "100%", fontSize: "0.9rem" };
export const cell: CSSProperties = {
  border: "1px solid #ddd",
  padding: "0.35rem 0.5rem",
  textAlign: "left",
  verticalAlign: "top",
};

export function fmtDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}

export function fmtMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `$${value.toLocaleString("en-US")}`;
}

export function Badge({ children, tone }: { children: ReactNode; tone?: "green" | "amber" | "red" | "gray" }) {
  const colors: Record<string, string> = {
    green: "#e6f4ea",
    amber: "#fff4d6",
    red: "#fde7e9",
    gray: "#eee",
  };
  return (
    <span
      style={{
        background: colors[tone ?? "gray"],
        borderRadius: 4,
        padding: "0.1rem 0.4rem",
        fontSize: "0.8rem",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

export function healthTone(state: string): "green" | "amber" | "red" | "gray" {
  return state === "green" ? "green" : state === "amber" ? "amber" : state === "red" ? "red" : "gray";
}

import type { ReactNode } from 'react';

/** アカウントの札（色の丸と名前）。名前が無ければ出さない。 */
export function AccountTag({ name, color }: { name: string | null; color: string | null }): ReactNode {
  if (!name) return null;
  return (
    <span className="acct-tag">
      <i style={color ? { backgroundColor: color } : undefined} aria-hidden="true" />
      {name}
    </span>
  );
}

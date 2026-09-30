import { fireEvent, screen } from '@testing-library/react';

/** Listbox の顔を押して開き、名前の一致する行を選ぶ。素の select の fireEvent.change の代わりに使う。 */
export function pick(face: string, option: string | RegExp): void {
  fireEvent.click(screen.getByRole('button', { name: face }));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

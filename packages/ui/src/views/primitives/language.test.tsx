import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LanguageRoot, useLanguage, useT } from './language.tsx';

function Probe() {
  const t = useT();
  return <p data-testid="probe" lang={useLanguage()}>{t('sessions.list.count', { n: 2 })} / {t('common.button.cancel')}</p>;
}

describe('View から辞書を引く', () => {
  it('頂点が無いところでは日本語で引く', () => {
    // View だけを描く既存の試験は、頂点を置かなくても日本語の文で走る。
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('2 件のセッション / キャンセル');
    expect(screen.getByTestId('probe')).toHaveAttribute('lang', 'ja');
  });
  it('頂点から受け取った言語で引き、言語が変われば描き直す', () => {
    const { rerender } = render(<LanguageRoot language="en"><Probe /></LanguageRoot>);
    expect(screen.getByTestId('probe')).toHaveTextContent('2 sessions / Cancel');
    expect(screen.getByTestId('probe')).toHaveAttribute('lang', 'en');
    rerender(<LanguageRoot language="ja"><Probe /></LanguageRoot>);
    expect(screen.getByTestId('probe')).toHaveTextContent('2 件のセッション / キャンセル');
  });
});

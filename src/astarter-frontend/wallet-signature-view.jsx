import React from 'react';
import './wallet-signature.css';

const instructions = {
  en: 'Sign the message in your wallet to confirm you own this address.',
  zh: '请在钱包中签署登录消息，确认这是你的地址。',
  es: 'Firma el mensaje en tu billetera para confirmar que esta dirección es tuya.',
  fr: 'Signez le message dans votre portefeuille pour confirmer que cette adresse vous appartient.',
  ja: 'ウォレットでメッセージに署名し、このアドレスの所有者であることを確認してください。',
  ko: '지갑에서 메시지에 서명해 이 주소의 소유자임을 확인하세요.',
  ru: 'Подпишите сообщение в кошельке, чтобы подтвердить, что этот адрес принадлежит вам.',
  vi: 'Ký thông điệp trong ví để xác nhận bạn sở hữu địa chỉ này.'
};

function Icon({name}) {
  const paths = {
    close: 'm6 6 12 12M18 6 6 18',
    wallet: 'M18 7H6a2 2 0 0 0 0 4h13v8H6a2 2 0 0 1-2-2V9m15 4h-4v4h4',
    arrow: 'M5 12h14m-6-6 6 6-6 6'
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]}/></svg>;
}

function SignalLines() {
  return <svg className="wallet-proof__waves" viewBox="0 0 142 74" preserveAspectRatio="none" aria-hidden="true">
    {Array.from({length: 9}, (_, i) => {
      const start = 7 + i * 7;
      return <path key={i} d={`M-4 ${start} C27 ${start} 29 38 58 38 S93 ${66 - i * 7} 147 ${12 + i * 6}`}/>;
    })}
  </svg>;
}

export function WalletSignatureView({address, network, status, nonce, errorMessage, t, onSign, onNonce, onClose}) {
  const language = (document.documentElement.lang || 'en').toLowerCase().split('-')[0];
  const error = status === 'idle' && Boolean(errorMessage);
  const pending = !error && (!nonce || status !== 'idle');
  const phase = error ? 'error' : status === 'idle' && !nonce ? 'preparing' : status;
  const label = pending
    ? t(status === 'signing' ? 'sign_in.signature.waiting' : status === 'verifying' ? 'sign_in.signature.verifying' : 'sign_in.message.preparing')
    : t(error && !nonce ? 'connect.secondary_action.retry.label' : 'sign_in.message.send');
  return <section className="wallet-proof" data-phase={phase} aria-describedby="wallet-proof-help" data-no-translate="">
    <header className="wallet-proof__header">
      <span className="wallet-proof__brand"><i aria-hidden="true"/>ASTARTER</span>
      <button type="button" className="wallet-proof__close" onClick={onClose} aria-label={t('sign_in.message.cancel')}><Icon name="close"/></button>
    </header>
    <h2 id="rk_connect_title">{t('sign_in.label')}</h2>
    <p className="wallet-proof__help" id="wallet-proof-help">{instructions[language] || instructions.en}</p>
    {address && <div className="wallet-proof__account">
      <div className="wallet-proof__identity">
        {network && <span className="wallet-proof__network"><Icon name="wallet"/>{network}</span>}
        <bdi className="wallet-proof__address" title={address} dir="ltr">{address.slice(0, 6)}…{address.slice(-4)}</bdi>
      </div>
      <SignalLines/>
    </div>}
    {error && <p role="alert" className="wallet-proof__error">{errorMessage}</p>}
    <footer className="wallet-proof__actions">
      <button type="button" className="wallet-proof__cancel" onClick={onClose}>{t('sign_in.message.cancel')}</button>
      <button type="button" className="wallet-proof__sign" data-testid="rk-auth-message-button" disabled={pending} onClick={nonce ? onSign : onNonce}>
        {pending && <i className="wallet-proof__progress" aria-hidden="true"/>}
        <span role="status" aria-live="polite" aria-atomic="true">{label}</span>
        {!pending && <Icon name="arrow"/>}
      </button>
    </footer>
  </section>;
}

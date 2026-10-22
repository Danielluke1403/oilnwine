document.addEventListener('click', event => {
  const link = event.target.closest('[data-return-back]');
  if (!link) return;
  const referrer = document.referrer;
  if (!referrer) return;
  try {
    const previous = new URL(referrer);
    if (previous.origin !== window.location.origin || previous.href === window.location.href) return;
    event.preventDefault();
    window.location.assign(previous.href);
  } catch {}
});

// Service worker for Web Push only: show the notification, open the app on click.
self.addEventListener('push', (event) => {
  let data = { title: 'Auction', body: 'You have an update.', url: '/#/me' };
  try { data = { ...data, ...event.data.json() }; } catch { /* keep the default */ }
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, data: { url: data.url }, tag: 'auction' }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? '/', self.location.origin).href;
  // Reuse an open tab (or the installed app) instead of stacking new windows on phones.
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
    const tab = tabs.find((t) => new URL(t.url).origin === self.location.origin);
    return tab ? tab.focus().then((t) => t.navigate(url)).catch(() => self.clients.openWindow(url)) : self.clients.openWindow(url);
  }));
});

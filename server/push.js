import webpush from 'web-push';

export function createPushSender({ publicKey, privateKey, subject }) {
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return async function sendPush(subscription, payload, { ttl }) {
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: ttl, urgency: 'high' });
      return { gone: false };
    } catch (error) {
      // 404 and 410 mean the browser dropped this subscription for good.
      if (error.statusCode === 404 || error.statusCode === 410) return { gone: true };
      console.warn(`Push failed with status ${error.statusCode ?? 'unknown'}`);
      return { gone: false };
    }
  };
}

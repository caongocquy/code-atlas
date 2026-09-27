import { findEligibleSubscribers } from "./subscribers.js";

export function renderDigest(): string {
  return "weekly bulletin";
}

export function deliverDigest(): number {
  const recipients = findEligibleSubscribers();
  const digest = renderDigest();
  return recipients.length + digest.length;
}

export function retryDigestDelivery(): number {
  return renderDigest().length;
}

export function previewDigest(): string {
  return renderDigest();
}

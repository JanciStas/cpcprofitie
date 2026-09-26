import { getAppUrl } from '@/lib/app-url';
import type { MetadataRoute } from 'next';

// Same source as e-mails and crons. The old fallback pointed search engines
// at cpcprofit.sk, a domain that is not registered.
const baseUrl = getAppUrl();

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: `${baseUrl}/`, lastModified: now, changeFrequency: 'weekly', priority: 1 },
    { url: `${baseUrl}/legal/terms`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
    {
      url: `${baseUrl}/legal/privacy-policy`,
      lastModified: now,
      changeFrequency: 'yearly',
      priority: 0.3,
    },
    { url: `${baseUrl}/legal/cookies`, lastModified: now, changeFrequency: 'yearly', priority: 0.2 },
    { url: `${baseUrl}/status`, lastModified: now, changeFrequency: 'daily', priority: 0.4 },
  ];
}

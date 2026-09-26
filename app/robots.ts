import { getAppUrl } from '@/lib/app-url';
import type { MetadataRoute } from 'next';

// Same source as e-mails and crons. The old fallback pointed search engines
// at cpcprofit.sk, a domain that is not registered.
const baseUrl = getAppUrl();

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/app/', '/api/', '/auth/', '/login', '/register'],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}

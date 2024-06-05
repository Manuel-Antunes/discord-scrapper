/**
 * This template is a production ready boilerplate for developing with `PlaywrightCrawler`.
 * Use this to bootstrap your projects using the most up-to-date code.
 * If you're looking for examples or want to learn more, see README.
 */

// For more information, see https://docs.apify.com/sdk/js
import { Actor } from 'apify';
// For more information, see https://crawlee.dev
import { PlaywrightCrawler } from 'crawlee';
// this is ESM project, and as such, it requires you to specify extensions in your relative imports
// read more about this here: https://nodejs.org/docs/latest-v18.x/api/esm.html#mandatory-file-extensions
// note that we need to use `.js` even when inside TS files
import { config } from './config.js';
import { router } from './routes.js';
import { CrawlerInput } from './types.js';

// Initialize the Apify SDK
await Actor.init();

const proxyConfiguration = await Actor.createProxyConfiguration();

const input: CrawlerInput | null = await Actor.getInput();

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl: config.maxRequestsPerCrawl,
    requestHandler: router,
    headless: false,
    useSessionPool: true,
    // Overrides default Session pool configuration.
    sessionPoolOptions: {
        maxPoolSize: 1000,
    },
    // Set to true if you want the crawler to save cookies per session,
    // and set the cookie header to request automatically (default is true).
    persistCookiesPerSession: true,
    launchContext: {
        userDataDir: process.env.NODE_ENV === 'development' ? './storage/user-data' : undefined,
    },
    browserPoolOptions: {
        useFingerprints: false, // this is the default
    },
});

await crawler.run(config.startUrls.map((url) => {
    return {
        url,
        userData: {
            email: input?.email,
            password: input?.password,
            channels: input?.channels,
        },
    };
}));

// Exit successfully
await Actor.exit();

import { Actor, KeyValueStore, Log } from 'apify';
import { Dictionary, PlaywrightCrawler, Request, createPlaywrightRouter, playwrightUtils } from 'crawlee';
import { Page } from 'playwright';
import {
    avatarSelector,
    connectedAccountContainerSelector,
    memberElementSelector,
    memberListSelector,
    panelsSelector,
    showMembersSelector,
} from './constants.js';
import { AuthData, CrawlerInput, MemberSoftData } from './types.js';
import { crawInfiniteList, login, setPageAuthData } from './utils.js';

export const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ request, page, crawler, log, browserController }) => {
    log.info('Default handler');
    const { channels } = request.userData as CrawlerInput;
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => null);
    log.info('Check for login');
    const isLoggedIn = await page.waitForSelector(panelsSelector, {
        timeout: 10000,
    }).then(() => true).catch(() => false);
    if (!isLoggedIn) {
        await login(browserController, request, page, log);
    }
    if (crawler.autoscaledPool?.maxConcurrency) {
        crawler.autoscaledPool.desiredConcurrency = 1 + channels.length;
        crawler.autoscaledPool.maxConcurrency = 1 + channels.length;
    }
    await crawler.addRequests(channels.map(
        (el) => ({
            url: el,
            label: 'channel',
            userData: request.userData,
        }),
    ));
});

router.use(async ({ page, log, request, browserController }) => {
    log.info('Check for login');
    const originalUrl = page.url();
    const authData = await KeyValueStore.getValue<AuthData>('authData');
    if (authData) {
        await setPageAuthData(page, authData);
        await page.reload();
    }

    const isLoggedIn = await page.waitForSelector(panelsSelector, {
        timeout: 5000,
    }).then(() => true).catch(() => false);
    const pageUrl = page.url();
    if (!pageUrl.includes('login')) {
        await page.reload();
        return;
    }

    if (!isLoggedIn) {
        await login(browserController, request, page, log);
        await page.goto(originalUrl);
    }
});

router.addHandler('channel', async ({ page, log, crawler, request }) => {
    const channelId = page.url().replace('https://discord.com/channels/', '').split('/').at(0);
    await page.waitForSelector(showMembersSelector);
    const title = await page.title();
    const channelName = title.split(' | ').at(-1);
    log.info(`Collecting members from channel ${channelName}`);
    const showMembersButton = await page.$(showMembersSelector);
    if (!showMembersButton) {
        throw new Error('Show members button not found');
    }
    const isOpen = await showMembersButton.evaluate((el) => (!!el.classList.toString().includes('selected_')));

    if (!isOpen) {
        await showMembersButton.click();
    }
    await page.waitForSelector(memberElementSelector);

    await page.waitForLoadState('networkidle', {
        timeout: 5000,
    });

    await playwrightUtils.saveSnapshot(page, { key: 'channel', saveHtml: false });

    const listElements = await crawInfiniteList(page, memberListSelector, memberElementSelector, (el) => {
        const displayName = el.querySelector('[class*="username_"]')?.textContent || '';
        const userName = el.querySelector('[class*="wrapper_"]')?.getAttribute('aria-label')?.split(',')?.at(0) || '';
        return {
            displayName,
            userName,
        };
    }, async (data) => {
        await crawler.addRequests([{
            label: 'member-inner',
            userData: {
                ...data,
                ...request.userData,
                channelId,
            },
            uniqueKey: `${data.userName}-${channelId}`,
            url: page.url(),
        }]);
    });
    log.info(`Number of members: ${listElements.length}`);
    if (crawler.autoscaledPool?.maxConcurrency) {
        crawler.autoscaledPool.desiredConcurrency -= 1;
        crawler.autoscaledPool.maxConcurrency -= 1;
    }
});

async function scrollToCrawUser(
    page: Page,
    userData: MemberSoftData,
    log: Log,
    channelName: string,
    crawler: PlaywrightCrawler,
    request: Request<Dictionary> | null,
) {
    let foundSelector: string | undefined;
    let nextSelector: string | undefined;
    await crawInfiniteList(page, memberListSelector, memberElementSelector, (el) => {
        const name = el.querySelector('[class*="wrapper_"]')?.getAttribute('aria-label')?.split(',')?.at(0) || '';
        el.id = `member-${name}`.replace(/#/g, '').replace(/\./g, '').replace(/[^a-zA-Z1-9]/g, '');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const [wrapper, index]: string = (el.parentNode as any).dataset.listItemId.split('___');
        return { name, index, wrapper };
    }, async (data) => {
        if (userData.userName === data.name) {
            foundSelector = `member-${data.name}`.replace(/#/g, '').replace(/\./g, '').replace(/[^a-zA-Z1-9]/g, '');
            nextSelector = `div[data-list-item-id="${data.wrapper}___${parseInt(data.index, 10) + 1}"] ${memberElementSelector}`;
            return true;
        }
        return undefined;
    });
    if (!foundSelector) {
        throw new Error('Member not found');
    }
    const memberElement = await page.$(`#${foundSelector}`);
    if (!memberElement) {
        throw new Error('Member element not found');
    }
    log.info(`Found member ${userData.displayName}#${userData.userName}`);
    await memberElement.click();
    await page.waitForLoadState('networkidle', {
        timeout: 5000,
    });
    const avatarLocator = page.locator(avatarSelector);
    const visible = await avatarLocator.waitFor({
        timeout: 4500,
    }).then(
        () => true,
    ).catch(() => false);
    if (visible) {
        const id = await page.$eval(`${avatarSelector} img`, (el) => {
            const src = el.getAttribute('src');
            if (src) {
                return src.replace(/.*\/avatars\/(.*)\/.*/gm, '$1');
            }
            return '';
        });
        await avatarLocator.click();
        await page.waitForLoadState('networkidle', {
            timeout: 5000,
        });
        await page.waitForSelector('[class*="body_"]');

        const [discordMemberSince, channelMemberSince] = await page.$$eval('[class*="memberSince_"]', (el) => el.map((e) => e.textContent || ''));
        const roles = await page.$$eval('[class*="role_"][class*="pill_"]:not([class*="addButton_"])', (el) => el.map((e) => e.textContent || ''));

        const displayName = await page.locator('[class*="nickname_"]').textContent({ timeout: 500 }).catch(() => '');
        const userName = await page.locator('[class*="userTagUsername_"]').textContent({ timeout: 500 }).catch(() => '');
        const status = await page.locator('[class*="statusText_"]').textContent({ timeout: 500 }).catch(() => '');
        const socialNetworks = (await page.$$eval(connectedAccountContainerSelector, (sel) => {
            return sel.map((el) => {
                const socialNetwork = el.querySelector('img')?.ariaLabel;
                const link = el.querySelector('a')?.href;
                const name = el.querySelector('[class*="connectedAccountNameText_"]')?.textContent;
                return { socialNetwork, link, name };
            });
        })).reduce((acc, el) => {
            acc[el.socialNetwork || ''] = {
                link: el.link || '',
                name: el.name || '',
            };
            return acc;
        }, {} as Record<string, { link: string, name: string }>);
        log.info(`Member: ${displayName}#${userName} Status: ${status} Number of Social Networks: ${Object.keys(socialNetworks).length}`);
        const channelId = page.url().replace('https://discord.com/channels/', '').split('/').at(0);
        await Actor.pushData({
            displayName,
            userName,
            status,
            socialNetworks,
            discordMemberSince,
            channelMemberSince,
            roles,
            channelName,
            channelId,
            id,
        });
    }
    await page.keyboard.press('Escape');
    const requestQueue = await crawler.getRequestQueue();
    const nextRequest = await requestQueue.fetchNextRequest();
    if (request) {
        log.info(`Request exists: ${userData.userName} marked as handled`);
        await requestQueue.markRequestHandled(request);
    }
    if (nextSelector) {
        const nextElement = await page.$(nextSelector);
        if (nextElement) {
            const nextDisplayName = await nextElement.evaluate((el) => el.querySelector('[class*="username_"]')?.textContent || '');
            const nextUsername = await nextElement.evaluate((el) => {
                return el.querySelector('[class*="wrapper_"]')?.getAttribute('aria-label')?.split(',')?.at(0) || '';
            },
            );
            if (nextUsername) {
                await scrollToCrawUser(page, { userName: nextUsername, displayName: nextDisplayName }, log, channelName, crawler, nextRequest);
            }
        }
    }
}

router.addHandler('member-inner', async ({ page, log, request, crawler }) => {
    const userData = request.userData as MemberSoftData;
    await page.waitForSelector(showMembersSelector);
    const title = await page.title();
    const channelName = title.split(' | ').at(-1);
    log.info(`Collecting data from member ${userData.displayName} on channel ${channelName}`);
    const showMembersButton = await page.$(showMembersSelector);
    if (!showMembersButton) {
        throw new Error('Show members button not found');
    }
    const isOpen = await showMembersButton.evaluate((el) => (!!el.classList.toString().includes('selected_')));
    if (!isOpen) {
        await showMembersButton.click();
    }
    await page.waitForSelector(memberElementSelector);
    await page.waitForLoadState('networkidle', {
        timeout: 5000,
    });
    await scrollToCrawUser(page, userData, log, channelName || '', crawler, request);
});

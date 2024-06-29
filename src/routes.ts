/* eslint-disable max-len */
import { Actor, Log } from 'apify';
import { Dictionary, PlaywrightCrawler, Request, createPlaywrightRouter, playwrightUtils } from 'crawlee';
import { Page } from 'playwright';
import { CrawlerInput, MemberSoftData } from './types.js';
import { crawInfiniteList } from './utils.js';

export const router = createPlaywrightRouter();

async function login(page: Page, request: Request, log: Log) {
    await page.goto('https://discord.com/login');
    log.info('Logging in');
    const { email, password } = request.userData as CrawlerInput;
    await page.waitForLoadState('networkidle');
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => null);
    await playwrightUtils.saveSnapshot(page, { key: 'login', saveHtml: false });
    // get current page url
    const url = page.url();
    log.info(`Current URL: ${url}`);
    if (url.includes('discord.com/channels/@me')) {
        return;
    }

    await page.fill('input[name="email"]', email, {
        timeout: 1000,
    });
    await page.waitForTimeout(1000);
    await page.fill('input[name="password"]', password, {
        timeout: 1000,
    });
    await page.click('button[type="submit"]');
    await playwrightUtils.saveSnapshot(page, { key: 'login-filled', saveHtml: false });
    await page.waitForURL('https://discord.com/channels/@me');
}

router.addDefaultHandler(async ({ request, page, crawler, log }) => {
    log.info('Default handler');
    const { channels } = request.userData as CrawlerInput;
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => null);
    log.info('Check for login');
    const isLoggedIn = await page.waitForSelector('.panels__58331', {
        timeout: 10000,
    }).then(() => true).catch(() => false);
    if (!isLoggedIn) {
        await login(page, request, log);
    }
    await crawler.addRequests(channels.map(
        (el) => ({
            url: el,
            label: 'channel',
            userData: request.userData,
        }),
    ));
});

router.use(async ({ page, log, request }) => {
    log.info('Check for login');
    const originalUrl = page.url();
    const isLoggedIn = await page.waitForSelector('.panels__58331', {
        timeout: 10000,
    }).then(() => true).catch(() => false);
    const pageUrl = page.url();
    if (!pageUrl.includes('login')) {
        await page.reload();
        return;
    }

    if (!isLoggedIn) {
        await login(page, request, log);
        await page.goto(originalUrl);
    }
});

router.addHandler('channel', async ({ page, log, crawler, request }) => {
    const channelId = page.url().replace('https://discord.com/channels/', '').split('/').at(0);
    const showMembersSel = '#app-mount > div.appAsidePanelWrapper__5e6e2 > div.notAppAsidePanel__95814 > div.app_b1f720 > div > div.layers__1c917.layers_a23c37 > div > div > div > div.content__76dcf > div.chat__52833 > div.subtitleContainer_f50402 > section > div > div.toolbar__62fb5 > div:nth-child(4)';
    await page.waitForSelector(showMembersSel);
    const title = await page.title();
    const channelName = title.split(' | ').at(-1);
    log.info(`Collecting members from channel ${channelName}`);
    const showMembersButton = await page.$(showMembersSel);
    if (!showMembersButton) {
        throw new Error('Show members button not found');
    }
    const isOpen = await showMembersButton.evaluate((el) => (!!el.classList.contains('selected__1fc53')));

    if (!isOpen) {
        await showMembersButton.click();
    }
    await page.waitForSelector('.memberInner__4dac6');

    await page.waitForLoadState('networkidle', {
        timeout: 5000,
    });

    await playwrightUtils.saveSnapshot(page, { key: 'channel', saveHtml: false });

    const listElements = await crawInfiniteList(page, '.members__573eb', '.memberInner__4dac6', (el) => {
        const displayName = el.querySelector('.username_ab1e31')?.textContent || '';
        const userName = el.querySelector('.wrapper__3ed10')?.getAttribute('aria-label')?.split(',')?.at(0) || '';
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
});

async function scrollToCrawUser(page: Page, userData: MemberSoftData, log: Log, channelName: string, crawler: PlaywrightCrawler, request: Request<Dictionary> | null) {
    let foundSelector: string | undefined;
    let nextSelector: string | undefined;
    await crawInfiniteList(page, '.members__573eb', '.memberInner__4dac6', (el) => {
        const name = el.querySelector('.wrapper__3ed10')?.getAttribute('aria-label')?.split(',')?.at(0) || '';
        el.id = `member-${name}`.replace(/#/g, '').replace(/\./g, '').replace(/[^a-zA-Z1-9]/g, '');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const [wrapper, index]: string = (el.parentNode as any).dataset.listItemId.split('___');
        return { name, index, wrapper };
    }, async (data) => {
        if (userData.userName === data.name) {
            foundSelector = `member-${data.name}`.replace(/#/g, '').replace(/\./g, '').replace(/[^a-zA-Z1-9]/g, '');
            nextSelector = `div[data-list-item-id="${data.wrapper}___${parseInt(data.index, 10) + 1}"] .memberInner__4dac6`;
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
    const avatarLocator = page.locator('.avatarWrapperNormal__36eec');
    await avatarLocator.waitFor();
    const [discordMemberSince, channelMemberSince] = await page.$$eval('.memberSince__963d9', (el) => el.map((e) => e.textContent || ''));
    const roles = await page.$$eval('.role_d81130.rolePill_f50ff5:not(.addButton__6f12b)', (el) => el.map((e) => e.textContent || ''));

    await avatarLocator.click();
    await page.waitForLoadState('networkidle', {
        timeout: 5000,
    });
    await page.waitForSelector('.body_bd4552');
    const displayName = await page.locator('.text-lg-semibold__9539a').textContent({ timeout: 500 }).catch(() => '');
    const userName = await page.locator('.discriminator__9d9f2').textContent({ timeout: 500 }).catch(() => '');
    const status = await page.locator('.customStatus_fe94ef').textContent({ timeout: 500 }).catch(() => '');
    const socialNetworks = (await page.$$eval('.connectedAccountContainer__5972d', (sel) => {
        return sel.map((el) => {
            const socialNetwork = el.querySelector('img')?.ariaLabel;
            const link = el.querySelector('a')?.href;
            const name = el.querySelector('.connectedAccountNameText__7abc2')?.textContent;
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
    await page.keyboard.press('Escape');
    const moreButton = await page.$('div:has(> .additionalActionsIcon__6b109)');
    let id: string = '';
    if (moreButton) {
        await moreButton.click();
        const clickIdButton = await page.$('div[id*="user-profile-actions-devmode-copy-id-"]');
        if (clickIdButton) {
            id = await clickIdButton.evaluate((el) => el.id.replace('user-profile-actions-devmode-copy-id-', '')).catch(() => '');
        }
    }
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
    const requestQueue = await crawler.getRequestQueue();
    const nextRequest = await requestQueue.fetchNextRequest();
    if (request) {
        log.info(`Request exists: ${userData.userName} marked as handled`);
        await requestQueue.markRequestHandled(request);
    }
    if (nextSelector) {
        const nextElement = await page.$(nextSelector);
        if (nextElement) {
            const nextDisplayName = await nextElement.evaluate((el) => el.querySelector('.username_ab1e31')?.textContent || '');
            const nextUsername = await nextElement.evaluate((el) => el.querySelector('.wrapper__3ed10')?.getAttribute('aria-label')?.split(',')?.at(0) || '');
            if (nextUsername) {
                await scrollToCrawUser(page, { userName: nextUsername, displayName: nextDisplayName }, log, channelName, crawler, nextRequest);
            }
        }
    }
}

router.addHandler('member-inner', async ({ page, log, request, crawler }) => {
    const userData = request.userData as MemberSoftData;
    const showMembersSel = '#app-mount > div.appAsidePanelWrapper__5e6e2 > div.notAppAsidePanel__95814 > div.app_b1f720 > div > div.layers__1c917.layers_a23c37 > div > div > div > div.content__76dcf > div.chat__52833 > div.subtitleContainer_f50402 > section > div > div.toolbar__62fb5 > div:nth-child(4)';
    await page.waitForSelector(showMembersSel);
    const title = await page.title();
    const channelName = title.split(' | ').at(-1);
    log.info(`Collecting data from member ${userData.displayName} on channel ${channelName}`);
    const showMembersButton = await page.$(showMembersSel);
    if (!showMembersButton) {
        throw new Error('Show members button not found');
    }
    const isOpen = await showMembersButton.evaluate((el) => (!!el.classList.contains('selected__1fc53')));
    if (!isOpen) {
        await showMembersButton.click();
    }
    await page.waitForSelector('.memberInner__4dac6');
    await page.waitForLoadState('networkidle', {
        timeout: 5000,
    });
    await scrollToCrawUser(page, userData, log, channelName || '', crawler, request);
});

/* eslint-disable max-len */
import { Actor, Log } from 'apify';
import { PlaywrightCrawler, Request, createPlaywrightRouter } from 'crawlee';
import { Page } from 'playwright';
import { CrawlerInput, MemberSoftData } from './types.js';
import { crawInfiniteList } from './utils.js';

export const router = createPlaywrightRouter();

async function login(page: Page, request: Request, log: Log, crawler: PlaywrightCrawler) {
    await page.goto('https://discord.com/login');
    log.info('Logging in');
    if (crawler.autoscaledPool) {
        crawler.autoscaledPool.maxConcurrency = 1;
        await crawler.autoscaledPool.pause();
    }
    const { email, password, channels } = request.userData as CrawlerInput;
    await page.waitForLoadState('networkidle');
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => null);
    // get current page url
    const url = page.url();
    log.info(`Current URL: ${url}`);
    if (url.includes('discord.com/channels/@me')) {
        await crawler.addRequests(channels.map(
            (el) => ({
                url: el,
                label: 'channel',
            }),
        ));
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
    await page.waitForURL('https://discord.com/channels/@me');
    if (crawler.autoscaledPool) {
        crawler.autoscaledPool.maxConcurrency = 4;
        crawler.autoscaledPool.resume();
    }
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
        await login(page, request, log, crawler);
    }
    await crawler.addRequests(channels.map(
        (el) => ({
            url: el,
            label: 'channel',
            userData: request.userData,
        }),
    ));
});

router.use(async ({ page, log, crawler, request }) => {
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
        await login(page, request, log, crawler);
        await page.goto(originalUrl);
    }
});

router.addHandler('channel', async ({ page, log, crawler, request }) => {
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
            },
            uniqueKey: data.userName,
            url: page.url(),
        }]);
    });
    log.info(`Number of members: ${listElements.length}`);
});

router.addHandler('member-inner', async ({ page, log, request }) => {
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
    let foundSelector: string | undefined;
    await crawInfiniteList(page, '.members__573eb', '.memberInner__4dac6', (el) => {
        const name = el.querySelector('.wrapper__3ed10')?.getAttribute('aria-label')?.split(',')?.at(0) || '';
        el.id = `member-${name}`;
        return { name };
    }, async (data) => {
        if (userData.userName === data.name) {
            foundSelector = `member-${data.name}`.replace(/#/g, '').replace(/\./g, '');
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
    await Actor.pushData({
        displayName,
        userName,
        status,
        socialNetworks,
        discordMemberSince,
        channelMemberSince,
        roles,
        channelName,
    });
});

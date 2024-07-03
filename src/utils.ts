import { KeyValueStore, Log } from 'apify';
import { PlaywrightController, Request, playwrightUtils } from 'crawlee';
import { Cookie, Page } from 'playwright';
import { emailInputSelector, iphoneUserAgent, loginButtonSelector, passwordInputSelector } from './constants.js';
import { AuthData, CrawlerInput, EditThisCookie } from './types.js';

export function editThisCookieToPlaywrightCookie(cookies: EditThisCookie[]): Cookie[] {
    return cookies.map((cookie) => {
        const sameSiteMap = {
            unspecified: 'None',
            lax: 'Lax',
            no_restriction: 'Strict',
        } as const;

        return {
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            expires: Math.floor(cookie.expirationDate as unknown as number),
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            sameSite: sameSiteMap[cookie.sameSite as keyof typeof sameSiteMap],
        };
    });
}

export async function crawInfiniteList<T>(page: Page,
    listSelector: string, elementSelector: string,
    elementCallback: (element: HTMLElement) => T, transferDataCallback: (data: T) => Promise<void | true>) {
    const selectedElements: T[] = [];
    let stop = false;
    async function transferData(data: T) {
        if (!stop) {
            selectedElements.push(data);
            stop = !!(await transferDataCallback(data));
        }
    }

    for await (const element of await page.$$(elementSelector)) {
        if (!stop) {
            const data = await element.evaluate(elementCallback);
            await transferData(data);
        } else {
            break;
        }
    }

    function observeMutation(args: string) {
        const { selector,
            elementSelector: elSelector,
            elementCallback: elCallback } = JSON.parse(args);
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        async function onMutationHandler(mutationsList) {
            for (const mutation of mutationsList) {
                if (mutation.addedNodes.length) {
                    for (const node of mutation.addedNodes) {
                        const element = node.querySelector(elSelector);
                        // eslint-disable-next-line no-new-func
                        const data = new Function('element', `return (${elCallback})(element)`)(element);
                        await transferData(data);
                    }
                }
            }
        }
        const observer = new MutationObserver(onMutationHandler);
        const virtualizedList = document.querySelector(selector);
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        observer.observe(virtualizedList, { childList: true, subtree: true });
    }
    const transferDataFunctionExists = await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        return !!window.transferData;
    });
    if (!transferDataFunctionExists) {
        await page.exposeFunction('transferData', transferData);
    }
    await page.evaluate(observeMutation, JSON.stringify({
        selector: listSelector,
        elementSelector,
        elementCallback: elementCallback.toString(),
    }));
    let retryScrollCount = 3;

    while (retryScrollCount > 0 && !stop) {
        try {
            const element = await page.$(listSelector);
            if (!element) throw new Error(`Element not found: ${listSelector}`);
            const scrollPosition = await element?.evaluate((el) => el.scrollTop);
            await element.evaluate((el) => el.scrollBy({ top: 150, behavior: 'smooth' }));
            await new Promise((resolve) => setTimeout(resolve, 500));

            await page.waitForFunction(`document.querySelector('${listSelector}').scrollTop > ${scrollPosition}`, {}, {
                timeout: 1000,
            });
            retryScrollCount = 3;
        } catch (error) {
            retryScrollCount--;
        }
    }
    return selectedElements;
}

export async function login(
    browserController: PlaywrightController,
    request: Request,
    oldPage: Page,
    log: Log,
) {
    const context = await browserController.browser.newContext({
        userAgent: iphoneUserAgent,
        viewport: {
            width: 375,
            height: 667,
        },
        isMobile: true,
    });
    const page = await context.newPage();
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

    await page.fill(emailInputSelector, email, {
        timeout: 1000,
    });
    await page.waitForTimeout(1000);
    await page.fill(passwordInputSelector, password, {
        timeout: 1000,
    });
    await page.click(loginButtonSelector);
    await playwrightUtils.saveSnapshot(page, { key: 'login-filled', saveHtml: false });
    await page.waitForURL('https://discord.com/channels/@me');
    await page.goto('https://discord.com/channels/@me');
    await page.waitForLoadState('networkidle');
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => null);
    const authData = await getPageAuthData(page);
    await page.close();
    await context.close();
    await setPageAuthData(oldPage, authData);
    await KeyValueStore.setValue('authData', authData);
}

export async function getPageAuthData(page: Page) {
    const obj = await page.evaluate(() => {
        function getLocalStoragePropertyDescriptor() {
            const iframe = document.createElement('iframe');
            document.head.append(iframe);
            const pd = Object.getOwnPropertyDescriptor(iframe.contentWindow, 'localStorage');
            iframe.remove();
            return pd;
        }

        // We have several options for how to use the property descriptor
        // once we have it. The simplest is to just redefine it:
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        Object.defineProperty(window, 'localStorage', getLocalStoragePropertyDescriptor());

        // eslint-disable-next-line no-unused-expressions
        window.localStorage.heeeeey; // yr old friend is bak

        // You can also use any function application tool, like `bind` or `call`
        // or `apply`. If you hold onto a reference to the object somehow, it
        // won’t matter if the global property gets deleted again, either.
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const localStorage = getLocalStoragePropertyDescriptor().get.call(window);
        const token = localStorage.getItem('token');
        const tokens = localStorage.getItem('tokens');
        return {
            token,
            tokens,
        };
    });
    return obj;
}

export async function setPageAuthData(
    page: Page,
    authData: AuthData,
) {
    await page.evaluate(({
        token, tokens,
    }) => {
        function getLocalStoragePropertyDescriptor() {
            const iframe = document.createElement('iframe');
            document.head.append(iframe);
            const pd = Object.getOwnPropertyDescriptor(iframe.contentWindow, 'localStorage');
            iframe.remove();
            return pd;
        }

        // We have several options for how to use the property descriptor
        // once we have it. The simplest is to just redefine it:
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        Object.defineProperty(window, 'localStorage', getLocalStoragePropertyDescriptor());

        // eslint-disable-next-line no-unused-expressions
        window.localStorage.heeeeey; // yr old friend is bak

        // You can also use any function application tool, like `bind` or `call`
        // or `apply`. If you hold onto a reference to the object somehow, it
        // won’t matter if the global property gets deleted again, either.
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const localStorage = getLocalStoragePropertyDescriptor().get.call(window);
        localStorage.setItem('token', token);
        localStorage.setItem('tokens', tokens);
    }, authData);
}

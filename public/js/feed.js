let parser = new RSSParser({
    requestOptions: {
        rejectUnauthorized: false
    }
});

let socialFeedDebug = true;

function sfDebug(message) {
    if (socialFeedDebug) {
        console.log(message);
    }
}

class FeedItem {
  constructor(source, sourceUrl, title, link, description, content, pubDate, guid) {
    this.source = source;
    this.sourceUrl = sourceUrl;
    this.title = title;
    this.link = link;
    this.description = description;
    this.content = content;
    this.pubDate = pubDate;
    this.guid = guid;
  }
}

class FeedSource {
    constructor(url, title) {
        this.url = url;
        this.title = title;
    }
}

class PostingStatus {
    constructor() {
        this.posting = false;
        this.posted = false;
        this.error = false;
        this.postedTimeout = null;
    }

    clearTimeout() {
        if (this.postedTimeout) {
            clearTimeout(this.postedTimeout);
        }
    }

    setPosting() {
        this.clearTimeout();
        this.posting = true;
        this.posted = false;
        this.error = false;
    }

    setPosted() {
        this.clearTimeout();
        this.posting = false;
        this.posted = true;
        this.error = false;

        this.postedTimeout = setTimeout(() => {
            this.posted = false;
        }, 5000);
    }

    setError() {
        this.clearTimeout();
        this.posting = false;
        this.posted = false;
        this.error = true;
    }
}

document.addEventListener('alpine:init', () => {
    Alpine.data('feed', function () {
        return {
            /**
             * @type {FeedSource[]}
             */
            feedUrls: this.$persist([
                // new FeedSource('https://rosswintle.uk/feed', 'rosswintle.uk'),
                // new FeedSource('https://fosstodon.org/@ross.rss', '@ross'),
                // new FeedSource('https://fosstodon.org/@alexstandiford.rss', '@alexstandiford'),
            ]),

            settings: this.$persist({
                wordpressUrl: '',
                wordpressUser: '',
                wordpressKey: '',
                mastodonInstanceUrl: '',
                mastodonAuthCode: '',
                mastodonAccessToken: '',
            }),

            /**
             * @type {FeedItem[]}
             */
            items: [],

            /**
             * @type {String}
             */
            newPostContent: this.$persist(''),

            /**
             * @type {Object}
             */
            postTargets: this.$persist({
                wordpress: false,
                mastodon: false,
            }),

            /**
             * @type {boolean}
             */
            settingsOpen: false,

            /**
             * Posting statuses
             */
            wordpressStatus: new PostingStatus(),
            mastodonStatus: new PostingStatus(),


            init() {
                this.fetchFeeds();
                this.$watch('feedUrls', () => {
                    this.fetchFeeds();
                })
            },

            removeFeed(index) {
                this.feedUrls.splice(index, 1);
            },

            async fetchFeeds() {
                sfDebug('Fetching feeds...');
                this.items = [];

                this.feedUrls.forEach(async url => await this.fetchFeed(url), this);
            },

            /**
             * Inserts an item into the feed list in the right (chronological) place.
             *
             * @param {FeedItem} item
             */
            insertItem(item) {
                // debugger;
                let index = this.items.findIndex(i => new Date(i.pubDate) < new Date(item.pubDate));
                if (index === -1) {
                    this.items.push(item);
                } else if (index === 0) {
                    this.items.unshift(item);
                } else {
                    this.items.splice(index, 0, item);
                }
            },

            /**
             * Title can be different things depending on the feed.
             *
             * @param {FeedItem} title
             */
            normalizeTitle(entry) {
                if (typeof(entry.title) === 'undefined') {
                    // Return the date in relative time format.
                    return dayjs(entry.pubDate).fromNow();
                }
                return entry;
            },

            /**
             *
             * @param {FeedSource} source
             */
            async fetchFeed(source) {
                sfDebug('Fetching feed: ' + source.url);
                let feed = await parser.parseURL(source.url);
                if (! feed) {
                    return;
                }
                console.log(feed);
                feed.items.forEach(function(entry) {
                    let title = this.normalizeTitle(entry);
                    // Push into correct (time-based) place.
                    let newItem = new FeedItem(source.title, feed.link, title, entry.link, entry.contentSnippet, entry.content, entry.pubDate, entry.guid);
                    this.insertItem(newItem);
                    console.log(title + ':' + entry.link);
                }, this);
            },

            /**
             * Does the actual posting.
             */
            async doPost() {
                let success = true;

                // Set statuses.
                if (this.postTargets.wordpress) {
                    this.wordpressStatus.setPosting();
                }
                if (this.postTargets.mastodon) {
                    this.mastodonStatus.setPosting();
                }

                // Do posts
                if (this.postTargets.wordpress) {
                    success = success && (await this.postToWordpress());
                }

                if (this.postTargets.mastodon) {
                    success = success && (await this.postToMastodon());
                }
                if (success) {
                    this.newPostContent = '';
                }

            },

            /**
             * Posts to WordPress.
             */
            async postToWordpress() {
                sfDebug('Posting to WordPress...');

                // Remove any '/' from the end of the wordpressUrl.
                this.settings.wordpressUrl = this.settings.wordpressUrl.replace(/\/$/, '');

                let response = await fetch(this.settings.wordpressUrl + '/wp-json/wp/v2/posts', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Basic ' + btoa(this.settings.wordpressUser + ':' + this.settings.wordpressKey),
                    },
                    body: JSON.stringify({
                        content: this.newPostContent,
                        status: 'publish',
                    }),
                });
                // TODO: Handle errors.

                this.wordpressStatus.setPosted();

                return true;
            },

            async makeMastodonApp() {
                sfDebug('Making Mastodon app...');

                // Remove any '/' from the end of the mastodonInstanceUrl.
                this.settings.mastodonInstanceUrl = this.settings.mastodonInstanceUrl.replace(/\/$/, '');

                let response = await fetch(this.settings.mastodonInstanceUrl + '/api/v1/apps', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        client_name: 'Social Feed',
                        redirect_uris: 'urn:ietf:wg:oauth:2.0:oob',
                        scopes: 'read:accounts write:statuses',
                        website: window.location.href,
                    }),
                });

                if (response.status !== 200) {
                    // TODO: Better handling of errors.
                    console.log('Error making Mastodon app.');
                    return false;
                }

                let data = await response.json();

                // Save the client ID and secret.
                this.settings.mastodonClientId = data.client_id;
                this.settings.mastodonClientSecret = data.client_secret;

                return true;
            },

            authorizeMastodonUser() {
                sfDebug('Authorizing Mastodon user...');

                // Remove any '/' from the end of the mastodonInstanceUrl.
                this.settings.mastodonInstanceUrl = this.settings.mastodonInstanceUrl.replace(/\/$/, '');

                // Open authorization in a new tab.
                window.open(
                    this.settings.mastodonInstanceUrl
                    + '/oauth/authorize?client_id=' + this.settings.mastodonClientId
                    + '&redirect_uri=urn%3Aietf%3Awg%3Aoauth%3A2.0%3Aoob&response_type=code&scope=read%3Aaccounts+write%3Astatuses'
                );
            },

            async getMastodonToken() {
                sfDebug('Getting Mastodon token...');

                // Remove any '/' from the end of the mastodonInstanceUrl.
                this.settings.mastodonInstanceUrl = this.settings.mastodonInstanceUrl.replace(/\/$/, '');

                let response = await fetch(this.settings.mastodonInstanceUrl + '/oauth/token', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        client_id: this.settings.mastodonClientId,
                        client_secret: this.settings.mastodonClientSecret,
                        redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
                        grant_type: 'authorization_code',
                        code: this.settings.mastodonAuthCode,
                        scope: 'read:accounts write:statuses',
                    }),
                });

                if (response.status !== 200) {
                    return false;
                }

                let data = await response.json();

                this.settings.mastodonAccessToken = data.access_token;
            },

            async postToMastodon() {
                sfDebug('Posting to Mastodon...');

                // Remove any '/' from the end of the mastodonInstanceUrl.
                this.settings.mastodonInstanceUrl = this.settings.mastodonInstanceUrl.replace(/\/$/, '');

                let response = await fetch(this.settings.mastodonInstanceUrl + '/api/v1/statuses', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.settings.mastodonAccessToken}`,
                    },
                    body: JSON.stringify({
                        status: this.newPostContent,
                        visibility: 'public',
                    }),
                });

                if (response.status !== 200) {
                    return false;
                }

                this.mastodonStatus.setPosted();

                return true;
            }
        }
    });
});

Planning thoughts:

I want to make sure to capture the engineer's contributions in a way that faithfully represents the value of the software they introduced to the product, the quantity and and quality of their interactions with the other PR and project contributors, I also want to capture the innovation that they bring that helps make this project comparatively more special than some of the other analytics github projects.

From experience, I know that posthog brings the industry a strong alternative to expensive and other tools like mixpanel, fullstory, hotjar, or the free tools like google analytics.

They also do a good job extending the value of their tracking too.

I'd also like to capture some metrics from their commit contributions, and perhaps how much of the core software assets they impacted and how.

For starters we should at least be able to dynamically fetch the, commits, the PRs, the public comments they wrote, how many issues they affected directly or otherwise.

In terms of how we could present the 1 screen dashboard we should competitively display the contributors so we can see an ordering in someway to compare who did what.

In terms of stack, I'll use a free firebase hosting deployment for the github repository since that should work fine and benefit from the CDN.

I'd like to at least have some minimal best practices since we only have a short time to make this.

Let's make sure the webpage works well-enough on pagespeed insights so others can see the page perform well on their phones or bad wifi connections, we should make the design aethestically pleasing, we need to use a backend firebase function to connect to github using the proper api rather than just spamming it from a webpage with CORS issues.

I'll be using my cursor IDE for this work with my free personal firebase.

Let's use the Shad.cn design system, with plotly for interactive diagrams to help this be elegant and crisp.

We should also get some analytics, but since I don't have much time and already have firebase we could as a stretch goal add google analytics.

I need to make sure this project is reproducible but never leak any secrets or keys.
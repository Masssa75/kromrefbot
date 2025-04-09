// KROM Referral Bot - Supabase Integrated Version
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

// --- Configuration ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const adminIdsString = process.env.ADMIN_USER_IDS || '';
const ADMIN_USER_IDS = adminIdsString.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
const TARGET_GROUP_ID_FROM_ENV = process.env.TARGET_GROUP_ID;
const TARGET_GROUP_ID_NUMERIC = parseInt(TARGET_GROUP_ID_FROM_ENV, 10);
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; // Use service key for server-side

// --- Configuration Checks ---
if (!token) { console.error("FATAL: Missing TELEGRAM_BOT_TOKEN!"); process.exit(1); }
if (ADMIN_USER_IDS.length === 0) { console.warn("WARN: No ADMIN_USER_IDS found."); }
if (!TARGET_GROUP_ID_FROM_ENV || isNaN(TARGET_GROUP_ID_NUMERIC)) { console.error("FATAL: Missing or invalid TARGET_GROUP_ID!"); process.exit(1); }
if (!supabaseUrl || !supabaseKey) { console.error("FATAL: Missing SUPABASE_URL or SUPABASE_SERVICE_KEY!"); process.exit(1); }

// --- Supabase Client Initialization ---
const supabase = createClient(supabaseUrl, supabaseKey, {
    // Optional: Configure Supabase client options if needed
    // auth: {
    //     persistSession: false // Recommended for server-side if not using auth features
    // }
});
console.log('Supabase client initialized.');

// --- Bot Initialization ---
console.log('Starting KROM Referral Bot...');
const bot = new TelegramBot(token, {
    polling: {
        interval: 300, autoStart: true, params: {
            timeout: 10, allowed_updates: JSON.stringify(["message", "chat_member", "callback_query"])
        }
    }
});
console.log('Bot instance created, polling for updates...');

// --- Helper Function for Escaping HTML ---
function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}


// --- Command Handlers ---

// /start command (Fallback verification / Welcome)
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const firstName = msg.from.first_name || 'User';

    if (msg.chat.type !== 'private') {
        console.log(`Ignoring /start command from ${firstName} in non-private chat (ID: ${chatId})`);
        return;
    }

    console.log(`Received /start command in DM from ${firstName} (User ID: ${userId})`);

    try {
        const { data: refData, error: refError } = await supabase
            .from('referrals')
            .select('verified')
            .eq('user_id', userId)
            .maybeSingle(); // Returns row or null

        if (refError) {
            console.error(`Supabase select error (/start check) for user ${userId}:`, refError.message);
            return bot.sendMessage(chatId, "Sorry, there was an error checking your status.");
        }

        if (refData && !refData.verified) {
            console.log(`User ${userId} (${firstName}) is unverified. Sending verification prompt via DM.`);
            const verificationMessage = `Thanks for joining via referral, ${escapeHtml(firstName)}! Please click the button below to verify you're human.`;
            const options = {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: '✅ Verify Me!', callback_data: `verify_${userId}` }]]
                }
            };
            bot.sendMessage(chatId, verificationMessage, options);
        } else if (refData && refData.verified) {
            console.log(`User ${userId} (${firstName}) is already verified.`);
            bot.sendMessage(chatId, `Hi ${escapeHtml(firstName)}! Welcome back. You are already verified.`);
        } else {
            console.log(`User ${userId} (${firstName}) not in referrals DB or started directly.`);
            bot.sendMessage(chatId, `Hi ${escapeHtml(firstName)}! Welcome to the KROM Referral Bot.`);
        }
    } catch (err) {
        console.error(`Unexpected error in /start handler for user ${userId}:`, err);
        bot.sendMessage(chatId, "An unexpected error occurred.");
    }
});

// /createlink command (Admin Only)
bot.onText(/\/createlink (.+)/, async (msg, match) => {
    const chatId = msg.chat.id; // DM chat ID
    const userId = msg.from.id; // Admin User ID
    const kolName = match[1]?.trim(); // Use optional chaining and trim

    if (msg.chat.type !== 'private') return bot.sendMessage(chatId, "Please use this command in a direct message.");
    if (!ADMIN_USER_IDS.includes(userId)) return bot.sendMessage(chatId, "Sorry, you don't have permission.");
    if (!kolName) return bot.sendMessage(chatId, "Usage: /createlink <KOL_Name>");

    const targetGroupId = TARGET_GROUP_ID_NUMERIC;
    console.log(`Admin ${userId} requesting link for KOL "${kolName}" for target group ${targetGroupId}`);

    try {
        // 1. Create Telegram Invite Link
        const inviteLink = await bot.createChatInviteLink(targetGroupId, { name: `KOL_${kolName}_${Date.now()}` });
        console.log(`Successfully created TG link for ${kolName}: ${inviteLink.invite_link}`);

        // 2. Save to Supabase
        const { error: dbError } = await supabase
            .from('kol_links')
            .insert([{ link_url: inviteLink.invite_link, kol_name: kolName }]);

        if (dbError) {
            console.error('Supabase insert error (kol_links):', dbError.message);
            // Attempt to revoke the created link if DB save failed? Complex. Log and notify admin is simpler.
            return bot.sendMessage(chatId, `❌ Error saving link to database for "${kolName}". Link was created but not tracked. Please report this.`);
        }

        console.log(`Link for ${kolName} saved to Supabase.`);
        bot.sendMessage(chatId, `✅ Invite link created for KOL "${kolName}":\n\`${inviteLink.invite_link}\``, { parse_mode: 'Markdown' });

    } catch (error) {
        // Handle Telegram API errors or other unexpected errors
        const telegramApiError = error.response?.body?.description || error.message || 'Unknown error';
        console.error(`Failed to create invite link or save for ${kolName}:`, telegramApiError);
        console.error("Full error object:", error);
        bot.sendMessage(chatId, `❌ Error creating invite link for "${kolName}".\nReason: ${telegramApiError}\n\nCheck bot permissions in target group (${targetGroupId}) and group ID correctness.`);
    }
});

// /getchatid command
bot.onText(/\/getchatid/, (msg) => {
    const chatId = msg.chat.id;
    const chatType = msg.chat.type;
    const chatTitle = escapeHtml(msg.chat.title || msg.from?.first_name || 'this chat');
    console.log(`Command /getchatid received in ${chatType} chat: "${chatTitle}" (ID: ${chatId})`);
    bot.sendMessage(chatId, `Chat: "${chatTitle}"\nType: \`${chatType}\`\nID: \`${chatId}\``, {parse_mode: 'Markdown'});
});

// /listkols command (Admin Only)
bot.onText(/\/listkols/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!ADMIN_USER_IDS.includes(userId)) return bot.sendMessage(chatId, "Sorry, you don't have permission.");
    if (msg.chat.type !== 'private') return bot.sendMessage(chatId, "Please use this command in DM.");

    console.log(`Admin ${userId} requested /listkols`);

    try {
        const { data: linksData, error: linksError } = await supabase
            .from('kol_links')
            .select('link_url, kol_name')
            .order('kol_name', { ascending: true }); // Order for readability

        if (linksError) {
            console.error("Supabase select error (listkols):", linksError.message);
            return bot.sendMessage(chatId, "Error fetching KOL links from database.");
        }

        if (!linksData || linksData.length === 0) {
            return bot.sendMessage(chatId, "No KOL links are currently being tracked.");
        }

        let response = `📊 **Tracked KOL Links (${linksData.length}):**\n\n`;
        let kolGroups = {};

        linksData.forEach(item => {
            const kolName = item.kol_name;
            if (!kolGroups[kolName]) { kolGroups[kolName] = []; }
            kolGroups[kolName].push(item.link_url);
        });

        for (const kolName in kolGroups) {
            response += `👤 **${escapeHtml(kolName)}:**\n`;
            kolGroups[kolName].forEach(link => {
                response += `   🔗 \`${link}\`\n`;
            });
            response += '\n';
        }

        // Consider Telegram message length limits for very long lists
        if (response.length > 4096) {
            response = response.substring(0, 4090) + "\n... (list truncated)";
        }
        bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });

    } catch(err) {
        console.error("Unexpected error in /listkols:", err);
        bot.sendMessage(chatId, "An unexpected error occurred while listing KOLs.");
    }
});

// /refcount command (Admin Only)
bot.onText(/\/refcount(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const specificKOL = match[1]?.trim();

    if (!ADMIN_USER_IDS.includes(userId)) return bot.sendMessage(chatId, "Sorry, you don't have permission.");
    if (msg.chat.type !== 'private') return bot.sendMessage(chatId, "Please use this command in DM.");

    console.log(`Admin ${userId} requested /refcount` + (specificKOL ? ` for KOL: ${specificKOL}` : ' (Total)'));

    try {
        let countQuery = supabase
            .from('referrals')
            .select('*', { count: 'exact', head: true }) // Gets only count
            .eq('verified', true);

        if (specificKOL) {
            // Use ilike for case-insensitive matching
            countQuery = countQuery.ilike('referred_by_kol_name', specificKOL);
        }

        const { count, error: countError } = await countQuery;

        if (countError) {
            console.error("Supabase count error (refcount):", countError.message);
            return bot.sendMessage(chatId, "Error fetching referral count from database.");
        }

        const countResult = count || 0; // Use 0 if count is null

        if (specificKOL) {
            // Optionally check if the KOL name exists at all in the DB for better feedback
            const { data: kolCheck, error: checkError } = await supabase
                .from('referrals') // Could also check kol_links table
                .select('user_id', { count: 'exact', head: true })
                .ilike('referred_by_kol_name', specificKOL);

            if (checkError) { /* Log error but proceed */ console.error("Supabase check error (refcount KOL exists):", checkError.message); }

             // Check if any referral entry exists for this KOL name *at all*
            if (!kolCheck || kolCheck.count === 0) {
                 bot.sendMessage(chatId, `❓ No referrals found associated with KOL "**${escapeHtml(specificKOL)}**".`);
            } else {
                 bot.sendMessage(chatId, `📊 Verified referral count for KOL **${escapeHtml(specificKOL)}**: ${countResult}`);
            }
        } else {
            bot.sendMessage(chatId, `📈 Total verified referrals across all KOLs: ${countResult}`);
        }
    } catch(err) {
        console.error("Unexpected error in /refcount:", err);
        bot.sendMessage(chatId, "An unexpected error occurred while counting referrals.");
    }
});

// --- Listener for Chat Member Updates ---
bot.on('chat_member', async (update) => {
    const eventChatId = update.chat.id;
    const chatTitle = update.chat.title || update.chat.username || 'Unknown Chat';

    if (eventChatId !== TARGET_GROUP_ID_NUMERIC) { return; } // Ignore other chats

    const newUser = update.new_chat_member.user;
    const oldStatus = update.old_chat_member?.status || '[null]';
    const newStatus = update.new_chat_member.status;
    const rawUserName = newUser.first_name || newUser.username || `User ${newUser.id}`;
    const safeUserName = escapeHtml(rawUserName); // Use escaped name for HTML output

    console.log(`Chat member update in TARGET GROUP (${chatTitle}): User ${safeUserName} (ID: ${newUser.id}) changed status from ${oldStatus} to ${newStatus}`);

    // --- Handle User Joining ---
    if (newStatus === 'member' && (oldStatus === 'left' || oldStatus === 'kicked' || oldStatus === '[null]')) {
        console.log(`User ${safeUserName} (ID: ${newUser.id}) JOINED the target group.`);

        const inviteLinkUrl = update.invite_link?.invite_link;
        if (inviteLinkUrl) {
            console.log(`User ${safeUserName} joined via link: ${inviteLinkUrl}`);

            // Check if link exists in Supabase
            let kolName = null;
            try {
                const { data: linkData, error: linkError } = await supabase
                    .from('kol_links')
                    .select('kol_name')
                    .eq('link_url', inviteLinkUrl)
                    .maybeSingle(); // Use maybeSingle to get one or null

                if (linkError) throw linkError; // Throw to catch block below
                if (linkData) {
                    kolName = linkData.kol_name;
                }
            } catch (dbError) {
                console.error(`Supabase select error (kol_links check) for link ${inviteLinkUrl}:`, dbError.message);
                // Continue without referral if DB lookup fails? Decide policy.
                // Logged error, will not record referral if kolName remains null.
            }


            if (kolName) {
                console.log(`Link corresponds to KOL: ${kolName}. Recording referral & sending prompt.`);

                // 1. Save/Update Referral in Supabase
                try {
                    const { error: upsertError } = await supabase
                        .from('referrals')
                        .upsert({ // upsert = update if exists (based on user_id), insert if not
                            user_id: newUser.id,
                            referred_by_kol_name: kolName,
                            user_name: rawUserName, // Store original name
                            join_date: new Date().toISOString(),
                            verified: false,
                            verification_date: null // Explicitly set null on new/re-join
                        }, { onConflict: 'user_id' }); // Specify conflict target

                    if (upsertError) throw upsertError; // Throw to catch block

                    console.log(`✅ Referral recorded/updated in Supabase for User ${safeUserName} (ID: ${newUser.id}).`);

                    // 2. Send Verification Prompt to Group
                    try {
                        const verificationMessageText = `Welcome <a href="tg://user?id=${newUser.id}">${safeUserName}</a>! You joined via ${escapeHtml(kolName)}'s link.\n\nPlease click the button below to verify you're human.`;
                        const options = {
                            parse_mode: 'HTML',
                            reply_markup: { inline_keyboard: [[{ text: '✅ Verify Me!', callback_data: `verify_${newUser.id}` }]] }
                        };
                        await bot.sendMessage(TARGET_GROUP_ID_NUMERIC, verificationMessageText, options);
                        console.log(`Verification prompt sent to group for user ${newUser.id}`);
                    } catch (tgError) {
                        console.error(`❌ Failed to send verification message to group for user ${newUser.id}:`, tgError.response?.body?.description || tgError.message);
                    }

                } catch (dbError) {
                    console.error(`Supabase upsert error (referrals) for user ${newUser.id}:`, dbError.message);
                    // Failed to save referral, maybe don't send prompt?
                }

            } else {
                console.log(`User ${safeUserName} joined via link (${inviteLinkUrl}), but link not found in DB.`);
            }
        } else {
            console.log(`User ${safeUserName} joined, but invite link info not provided by API. No referral recorded.`);
        }
    }
    // --- Handle User Leaving/Being Kicked ---
    else if (newStatus === 'left' || newStatus === 'kicked') {
         console.log(`User ${safeUserName} (ID: ${newUser.id}) LEFT or was KICKED.`);
         try {
            const { data: deleteData, error: deleteError } = await supabase
                .from('referrals')
                .delete()
                .eq('user_id', newUser.id)
                .select(); // See what was deleted (optional)

            if (deleteError) throw deleteError;

            // Check if any rows were actually deleted
            if (deleteData && deleteData.length > 0) {
                console.log(`Removed user ${newUser.id} from Supabase referrals.`);
            } else {
                // This case means the user wasn't found in the referrals table when they left
                console.log(`User ${newUser.id} left/kicked, but not found in Supabase referrals.`);
            }
         } catch (dbError) {
             console.error(`Supabase delete error (referrals leave) for user ${newUser.id}:`, dbError.message);
         }
    }
});

// --- Listener for Callback Queries (Inline Button Clicks) ---
bot.on('callback_query', async (callbackQuery) => {
    const message = callbackQuery.message;
    const data = callbackQuery.data;
    const userIdWhoClicked = callbackQuery.from.id;
    const callbackQueryId = callbackQuery.id;
    const chatWhereButtonPressed = message.chat.id;
    const messageWithButtonId = message.message_id;

    console.log(`Received callback_query from User ID: ${userIdWhoClicked} with data: ${data} in chat ${chatWhereButtonPressed}`);

    if (data && data.startsWith('verify_')) {
        const userIdToVerify = parseInt(data.split('_')[1], 10);

        // --- Security Check ---
        if (userIdWhoClicked !== userIdToVerify) {
            console.warn(`Security Alert: User ${userIdWhoClicked} tried to verify user ${userIdToVerify}!`);
            return await bot.answerCallbackQuery(callbackQueryId, { text: 'Error: Invalid action.', show_alert: true });
        }

        console.log(`Processing verification request for User ID: ${userIdToVerify}`);

        try {
            // Attempt to update verification status in Supabase
            const { data: updateData, error: updateError } = await supabase
                .from('referrals')
                .update({ verified: true, verification_date: new Date().toISOString() })
                .eq('user_id', userIdToVerify)
                .eq('verified', false) // Only update if currently false
                .select() // Fetch updated row
                .single(); // Expect only one row updated or none

            // Handle potential errors during update
            // PGRST116: row not found matching filter (likely already verified or doesn't exist)
            if (updateError && updateError.code !== 'PGRST116') {
                throw updateError; // Throw actual database errors
            }

            if (updateData) {
                // --- Verification Success ---
                console.log(`✅ User ${userIdToVerify} successfully verified in Supabase.`);
                await bot.answerCallbackQuery(callbackQueryId, { text: 'Verification successful!' });

                // Edit the original message
                try {
                    const storedUserName = escapeHtml(updateData.user_name || `User ${userIdToVerify}`);
                    await bot.editMessageText(`✅ <a href="tg://user?id=${userIdToVerify}">${storedUserName}</a> is now verified!`, {
                        chat_id: chatWhereButtonPressed,
                        message_id: messageWithButtonId,
                        parse_mode: 'HTML',
                        reply_markup: {} // Remove keyboard
                    });
                    console.log(`Edited verification message for user ${userIdToVerify} in chat ${chatWhereButtonPressed}.`);
                } catch (editError) {
                     // Ignore "message is not modified" or log other edit errors
                     if (editError.response?.body?.description.includes("message is not modified")) {
                        console.log(`Message for user ${userIdToVerify} was already edited.`);
                    } else {
                        console.error(`Error editing verification message for user ${userIdToVerify}:`, editError.response?.body?.description || editError.message);
                    }
                }
            } else {
                // --- Already Verified or User Not Found for Update ---
                // Check the current status from the DB again to give accurate feedback
                 const { data: checkData, error: checkError } = await supabase
                    .from('referrals')
                    .select('verified, user_name')
                    .eq('user_id', userIdToVerify)
                    .maybeSingle();

                 if (checkError){
                    console.error(`Supabase check error (callback already verified check) for user ${userIdToVerify}:`, checkError.message);
                    await bot.answerCallbackQuery(callbackQueryId, { text: 'Error checking status.', show_alert: true });
                 } else if (checkData?.verified) {
                    // User exists and is already verified
                    console.log(`User ${userIdToVerify} clicked verification but was already verified in DB.`);
                    await bot.answerCallbackQuery(callbackQueryId, { text: 'You are already verified.' });
                     try { // Try editing message just in case button is still there
                         const storedUserName = escapeHtml(checkData.user_name || `User ${userIdToVerify}`);
                         await bot.editMessageText(`✅ <a href="tg://user?id=${userIdToVerify}">${storedUserName}</a> is already verified.`, {
                            chat_id: chatWhereButtonPressed, message_id: messageWithButtonId, parse_mode: 'HTML', reply_markup: {}
                         });
                     } catch(editError){ /* Ignore if already edited */ }
                 } else {
                    // User not found in DB after attempting update
                     console.warn(`Verification callback for User ID: ${userIdToVerify}, but user not found.`);
                     await bot.answerCallbackQuery(callbackQueryId, { text: 'Error: Referral record not found.', show_alert: true });
                     try { // Edit message to show error state
                        await bot.editMessageText('Sorry, there was an issue finding your referral record.', {
                            chat_id: chatWhereButtonPressed, message_id: messageWithButtonId, reply_markup: {}
                        });
                     } catch (editError) { /* Ignore */ }
                 }
            }

        } catch(dbError) {
            // Catch actual database errors from the update attempt
            console.error(`Supabase error during verification callback for user ${userIdToVerify}:`, dbError.message);
            await bot.answerCallbackQuery(callbackQueryId, { text: 'Database error during verification.', show_alert: true });
        }

    } else {
        // Handle other potential callback data in the future
        console.log(`Received unhandled callback data: ${data}`);
        await bot.answerCallbackQuery(callbackQueryId); // Acknowledge silently
    }
});

// --- Error Handling ---
bot.on('polling_error', (error) => { console.error(`Polling error: ${error.code} - ${error.message}`); });
bot.on('webhook_error', (error) => { console.error(`Webhook error: ${error.code} - ${error.message}`); });
bot.on('error', (error) => { console.error('General Bot Error:', error); });

console.log('KROM Referral Bot (Supabase Integrated) is now listening...');

// --- End of Script ---
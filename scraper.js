// Parses the development applications at the South Australian Yorke Peninsula Council web site
// and places them in a database.
//
// Michael Bone
// 25th November 2018
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const cheerio = require("cheerio");
const request = require("request-promise-native");
const sqlite3 = require("sqlite3");
const moment = require("moment");
const didyoumean = require("didyoumean2");
sqlite3.verbose();
const DevelopmentApplicationsUrl = "https://yorke.sa.gov.au/development/development-information/development-register/?pagenum={0}&gv_search=&filter_1=&filter_3=&gv_start={1}&gv_end={2}&filter_7=&mode=all";
const InformationUrl = "https://yorke.sa.gov.au/development/development-information/development-register/?gv_search=&filter_1={0}&filter_3=&gv_start=&gv_end=&filter_7=&mode=all";
const CommentUrl = "mailto:admin@yorke.sa.gov.au";
// Address information.
let SuburbNames = undefined;
let HundredNames = undefined;
// Sets up an sqlite database.
async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        let database = new sqlite3.Database("data.sqlite");
        database.serialize(() => {
            database.run("create table if not exists [data] ([council_reference] text primary key, [address] text, [description] text, [info_url] text, [comment_url] text, [date_scraped] text, [date_received] text, [on_notice_from] text, [on_notice_to] text)");
            resolve(database);
        });
    });
}
// Inserts a row in the database if the row does not already exist.
async function insertRow(database, developmentApplication) {
    return new Promise((resolve, reject) => {
        let sqlStatement = database.prepare("insert or ignore into [data] values (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        sqlStatement.run([
            developmentApplication.applicationNumber,
            developmentApplication.address,
            developmentApplication.description,
            developmentApplication.informationUrl,
            developmentApplication.commentUrl,
            developmentApplication.scrapeDate,
            developmentApplication.receivedDate,
            null,
            null
        ], function (error, row) {
            if (error) {
                console.error(error);
                reject(error);
            }
            else {
                if (this.changes > 0)
                    console.log(`    Inserted: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\" and received date \"${developmentApplication.receivedDate}\" into the database.`);
                else
                    console.log(`    Skipped: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\" and received date \"${developmentApplication.receivedDate}\" because it was already present in the database.`);
                sqlStatement.finalize(); // releases any locks
                resolve(row);
            }
        });
    });
}
// Gets a random integer in the specified range: [minimum, maximum).
function getRandom(minimum, maximum) {
    return Math.floor(Math.random() * (Math.floor(maximum) - Math.ceil(minimum))) + Math.ceil(minimum);
}
// Pauses for the specified number of milliseconds.
function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
// Format the address, ensuring that it has a valid suburb name, state and post code.
function formatAddress(address) {
    // Remove a dot at the start of the address such as in ". HD CLINTON" or a dot in the middle
    // of an address such as in "7 The Esplanade . MARION BAY".  Remove any hundred name in
    // brackets (that often appears after the suburb name) such as in "106 Sultana Point Road
    // EDITHBURGH (Hd Melville)".  Replace multiple consecutive spaces with single spaces.
    address = address.replace(/^\. /g, " ").replace(/ \. /g, " ").replace(/ \(Hd.*?\)/gi, "").replace(/\s\s+/g, " ").trim();
    if (address === "")
        return address;
    // Do not attempt to format the address if it ends in a hundred name.  Otherwise the hundred
    // name may be incorrectly interpreted as a suburb name.  For example, "HD CLINTON"
    let uppercaseAddress = address.toUpperCase();
    for (let hundredName of HundredNames) {
        if (uppercaseAddress.toUpperCase() === "HD " + hundredName || uppercaseAddress.endsWith(" HD " + hundredName)) {
            console.log(`The state and post code will not be added because the address ends with a hundred name: ${address}`);
            return address;
        }
    }
    // Extract tokens from the end of the array until a valid suburb name is encountered
    // (allowing for a spelling error).  Prefer a longer suburb name over a shorter suburb
    // name.  For example, prefer "PORT CLINTON" over "CLINTON".
    let tokens = address.split(" ");
    let suburbName = null;
    for (let index = 4; index >= 1; index--) {
        let suburbNameMatch = didyoumean(tokens.slice(-index).join(" "), Object.keys(SuburbNames), { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 1, trimSpace: true });
        if (suburbNameMatch !== null) {
            suburbName = SuburbNames[suburbNameMatch];
            tokens.splice(-index, index); // remove elements from the end of the array           
            break;
        }
    }
    if (suburbName === null) { // suburb name not found (or not recognised)
        console.log(`The state and post code will not be added because the suburb was not recognised: ${address}`);
        return address;
    }
    // Add the suburb name with its state and post code to the street name.
    let streetName = tokens.join(" ").trim();
    return (streetName + ((streetName === "") ? "" : ", ") + suburbName).trim();
}
// Parses the development applications in the specified date range.
async function parse(dateFrom, dateTo, database) {
    console.log(`Retrieving development applications from ${dateFrom.format("YYYY-MM-DD")} to ${dateTo.format("YYYY-MM-DD")}.`);
    let dateFromText = encodeURIComponent(dateFrom.format("DD/MM/YYYY"));
    let dateToText = encodeURIComponent(dateTo.format("DD/MM/YYYY"));
    // Step through each page of the results for the specified date range.
    let pageNumber = 0;
    while (pageNumber++ < 100) { // safety precaution
        let developmentApplicationsUrl = DevelopmentApplicationsUrl.replace(/\{0\}/g, pageNumber.toString()).replace(/\{1\}/g, dateFromText).replace(/\{2\}/g, dateToText);
        console.log(`Retrieving page ${pageNumber}: ${developmentApplicationsUrl}`);
        let body = await request({ url: developmentApplicationsUrl, rejectUnauthorized: false, proxy: process.env.MORPH_PROXY });
        await sleep(2000 + getRandom(0, 5) * 1000);
        let $ = cheerio.load(body);
        // Parse the search results.
        for (let trElement of $("table.gv-table-view tr").get()) {
            let developmentApplicationUrl = $(trElement).find("#gv-field-31-1 a").attr("href");
            if (developmentApplicationUrl === undefined)
                continue;
            // Obtain the description for the application.
            let childBody = await request({ url: developmentApplicationUrl, rejectUnauthorized: false, proxy: process.env.MORPH_PROXY });
            let childPage = cheerio.load(childBody);
            let address = formatAddress($(trElement).find("#gv-field-31-7").text().trim());
            let applicationNumber = "";
            let receivedDate = moment.invalid();
            let description = "";
            for (let trElement of childPage("table.gv-table-view-content tr").get()) {
                let key = childPage(trElement).find("th").text().toUpperCase().trim();
                if (key === "DA NUMBER")
                    applicationNumber = childPage(trElement).find("td").text().trim();
                else if (key === "DATE APPLICATION RECEIVED")
                    receivedDate = moment(childPage(trElement).find("td").text().trim(), "D/MM/YYYY", true);
                else if (key === "DEVELOPMENT DETAILS")
                    description = childPage(trElement).find("td").text().trim().replace(/&apos;/g, "'");
            }
            // Ensure that at least an application number and address have been obtained.
            if (applicationNumber !== "" && applicationNumber !== undefined && address !== "" && address !== undefined) {
                let informationUrl = InformationUrl.replace(/\{0\}/g, encodeURIComponent(applicationNumber));
                await insertRow(database, {
                    applicationNumber: applicationNumber,
                    address: address,
                    description: description,
                    informationUrl: informationUrl,
                    commentUrl: CommentUrl,
                    scrapeDate: moment().format("YYYY-MM-DD"),
                    receivedDate: receivedDate.isValid ? receivedDate.format("YYYY-MM-DD") : ""
                });
            }
        }
        // If there is no "next page" link then assume this is the last page.
        let hasNextPageLink = ($("ul.page-numbers li a.next").length > 0);
        if (!hasNextPageLink) {
            console.log("Reached the last page of the paged search results.");
            return;
        }
    }
    console.log(`Stopped because reached ${pageNumber} pages.`);
}
// Parses the development applications.
async function main() {
    // Read the suburb names.
    SuburbNames = {};
    for (let line of fs.readFileSync("suburbnames.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let suburbTokens = line.toUpperCase().split(",");
        SuburbNames[suburbTokens[0].toUpperCase().trim()] = suburbTokens[1].toUpperCase().trim();
    }
    // Read the hundred names.
    HundredNames = [];
    for (let hundredName of fs.readFileSync("hundrednames.txt").toString().replace(/\r/g, "").trim().split("\n"))
        HundredNames.push(hundredName.toUpperCase().trim());
    // Ensure that the database exists.
    let database = await initializeDatabase();
    // Obtain the paged results of a search for the last month.
    await parse(moment().subtract(1, "months"), moment(), database);
    await sleep(5000 + getRandom(0, 10) * 1000);
    // Obtain the paged results of a search for a randomly selected month (to build up over time
    // a complete picture of all development applications, while avoiding overloading the web
    // server with a lot of requests).
    let monthCount = moment().year() * 12 + moment().month() - (1997 * 12 + 4); // first recorded development application is 16th April 1997
    let randomMonth = getRandom(1, monthCount + 1);
    await parse(moment().subtract(randomMonth + 1, "months"), moment().subtract(randomMonth, "months"), database);
}
main().then(() => console.log("Complete.")).catch(error => console.error(error));
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NyYXBlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInNjcmFwZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsK0ZBQStGO0FBQy9GLGlDQUFpQztBQUNqQyxFQUFFO0FBQ0YsZUFBZTtBQUNmLHFCQUFxQjtBQUVyQixZQUFZLENBQUM7O0FBRWIseUJBQXlCO0FBQ3pCLG1DQUFtQztBQUNuQyxrREFBa0Q7QUFDbEQsbUNBQW1DO0FBQ25DLGlDQUFpQztBQUNqQywwQ0FBMEM7QUFFMUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxDQUFDO0FBRWxCLE1BQU0sMEJBQTBCLEdBQUcseUtBQXlLLENBQUM7QUFDN00sTUFBTSxjQUFjLEdBQUcsMEpBQTBKLENBQUM7QUFDbEwsTUFBTSxVQUFVLEdBQUcsOEJBQThCLENBQUM7QUFJbEQsdUJBQXVCO0FBRXZCLElBQUksV0FBVyxHQUFHLFNBQVMsQ0FBQztBQUM1QixJQUFJLFlBQVksR0FBRyxTQUFTLENBQUM7QUFFN0IsOEJBQThCO0FBRTlCLEtBQUssVUFBVSxrQkFBa0I7SUFDN0IsT0FBTyxJQUFJLE9BQU8sQ0FBQyxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsRUFBRTtRQUNuQyxJQUFJLFFBQVEsR0FBRyxJQUFJLE9BQU8sQ0FBQyxRQUFRLENBQUMsYUFBYSxDQUFDLENBQUM7UUFDbkQsUUFBUSxDQUFDLFNBQVMsQ0FBQyxHQUFHLEVBQUU7WUFDcEIsUUFBUSxDQUFDLEdBQUcsQ0FBQywwT0FBME8sQ0FBQyxDQUFDO1lBQ3pQLE9BQU8sQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUN0QixDQUFDLENBQUMsQ0FBQztJQUNQLENBQUMsQ0FBQyxDQUFDO0FBQ1AsQ0FBQztBQUVELG1FQUFtRTtBQUVuRSxLQUFLLFVBQVUsU0FBUyxDQUFDLFFBQVEsRUFBRSxzQkFBc0I7SUFDckQsT0FBTyxJQUFJLE9BQU8sQ0FBQyxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsRUFBRTtRQUNuQyxJQUFJLFlBQVksR0FB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